/**
 * Semantic check for the `mergeCandidates` config flag. Replays every recorded discount input through one build of
 * the Function twice, as recorded (flag off unless the input already sets it) and with `"mergeCandidates": true`
 * injected into the config, and asserts that merging changed nothing a buyer can see: per cart line the multiset of
 * (value kind, value, message, discount code, quantity) of the product candidates is identical, every other operation
 * is byte-identical, the merged output has no more candidates, and it stays within Shopify's 40 kB output limit.
 * Also reports the instruction counts of both runs.
 *
 * Usage (CLI-built modules, as for compare-function-outputs.mjs):
 *   FUNCTION_RUNNER=<function-runner> node scripts/compare-merge-candidates.mjs --inputs <dump dir> [--root <repo root, default cwd>]
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    runner: { type: "string" },
    root: { type: "string", default: process.cwd() },
    inputs: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
if (!runner || !options.inputs) {
  console.error("Usage: FUNCTION_RUNNER=<path> node scripts/compare-merge-candidates.mjs --inputs <dir> [--root <repo root>]");
  process.exit(2);
}
const OUTPUT_LIMIT_BYTES = 40 * 1024;
const modules = ["discount-function", "code-discount-function"];
const wasmPath = (extension) =>
  join(resolve(options.root), "apps/shopify-admin/extensions", extension, "target/wasm32-wasip1/release", `promo-engine-${extension}.wasm`);

function run(wasm, input) {
  return new Promise((resolveRun) => {
    execFile(
      runner,
      ["-f", wasm, "-i", input, "-e", "cart_lines_discounts_generate_run", "-j"],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !stdout) return resolveRun({ failed: true, message: (stderr || error.message).trim() });
        try {
          const parsed = JSON.parse(stdout);
          resolveRun({ failed: false, output: parsed.output, instructions: parsed.instructions, size: parsed.output_size ?? Buffer.byteLength(JSON.stringify(parsed.output)) });
        } catch {
          resolveRun({ failed: true, message: `unparseable runner output: ${stdout.slice(0, 200)}` });
        }
      },
    );
  });
}

// Per line: a sorted list of what each candidate does to it. One candidate with N targets contributes to N lines.
function perLine(output) {
  const lines = new Map();
  for (const operation of output?.operations ?? []) {
    const add = operation.productDiscountsAdd;
    if (!add) continue;
    for (const candidate of add.candidates) {
      const value = candidate.value.percentage
        ? `pct:${candidate.value.percentage.value}`
        : `fixed:${JSON.stringify(candidate.value.fixedAmount)}`;
      const multi = candidate.targets.length;
      for (const target of candidate.targets) {
        const entry = `${value}|${candidate.message ?? ""}|${candidate.associatedDiscountCode?.code ?? ""}|q${target.cartLine.quantity ?? "-"}`;
        // A fixed amount that spans several lines is one discount over all of them: keep its shape in the key.
        const key = candidate.value.fixedAmount && multi > 1 ? `${entry}|multi${multi}` : entry;
        const list = lines.get(target.cartLine.id) ?? [];
        list.push(key);
        lines.set(target.cartLine.id, list);
      }
    }
  }
  for (const list of lines.values()) list.sort();
  return lines;
}

const candidateCount = (output) =>
  (output?.operations ?? []).reduce((total, operation) => total + (operation.productDiscountsAdd?.candidates.length ?? 0), 0);
const otherOperations = (output) => JSON.stringify((output?.operations ?? []).filter((operation) => !operation.productDiscountsAdd));

const scratch = await mkdtemp(join(tmpdir(), "merge-candidates-"));
let failures = 0;
let compared = 0;
let reduced = 0;
let peakBefore = 0;
let peakAfter = 0;
try {
  for (const extension of modules) {
    const directory = join(resolve(options.inputs), `promo-engine-${extension}`);
    let files;
    try {
      files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    const wasm = wasmPath(extension);
    const queue = [...files];
    const workers = Array.from({ length: Number(options.concurrency) }, async () => {
      while (queue.length) {
        const file = queue.shift();
        const text = await readFile(join(directory, file), "utf8");
        const input = JSON.parse(text);
        const raw = input?.discount?.metafield?.value;
        if (typeof raw !== "string") continue;
        let config;
        try {
          config = JSON.parse(raw);
        } catch {
          continue;
        }
        const off = { ...input, discount: { ...input.discount, metafield: { value: JSON.stringify({ ...config, mergeCandidates: false }) } } };
        const on = { ...input, discount: { ...input.discount, metafield: { value: JSON.stringify({ ...config, mergeCandidates: true }) } } };
        const offPath = join(scratch, `${extension}-${file}.off.json`);
        const onPath = join(scratch, `${extension}-${file}.on.json`);
        await Promise.all([writeFile(offPath, JSON.stringify(off)), writeFile(onPath, JSON.stringify(on))]);
        const [before, after] = await Promise.all([run(wasm, offPath), run(wasm, onPath)]);
        await Promise.all([rm(offPath), rm(onPath)]);
        const problems = [];
        if (before.failed || after.failed) {
          if (before.failed !== after.failed) problems.push(`one run failed: ${before.message ?? after.message}`);
        } else {
          compared++;
          peakBefore = Math.max(peakBefore, before.instructions);
          peakAfter = Math.max(peakAfter, after.instructions);
          const lineBefore = perLine(before.output);
          const lineAfter = perLine(after.output);
          if (JSON.stringify([...lineBefore].sort()) !== JSON.stringify([...lineAfter].sort())) problems.push("per-line discounts differ");
          if (otherOperations(before.output) !== otherOperations(after.output)) problems.push("non-product operations differ");
          if (candidateCount(after.output) > candidateCount(before.output)) problems.push("merge increased the candidate count");
          if (candidateCount(after.output) < candidateCount(before.output)) reduced++;
          if (after.size > OUTPUT_LIMIT_BYTES && before.size <= OUTPUT_LIMIT_BYTES) problems.push(`merged output is ${after.size} bytes`);
        }
        if (problems.length) {
          failures++;
          console.error(`[merge] ${extension}/${file}: ${problems.join("; ")}`);
        }
      }
    });
    await Promise.all(workers);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.info(
  `[merge] ${compared} inputs compared, ${reduced} with fewer candidates, ${failures} semantic differences; instruction peak ${peakBefore} -> ${peakAfter}`,
);
process.exit(failures ? 1 : 0);
