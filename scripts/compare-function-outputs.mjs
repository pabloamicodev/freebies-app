/**
 * Replays recorded Function inputs through two builds of the Function wasm (baseline vs candidate) with Shopify's
 * function-runner and asserts the outputs are identical; also reports instruction counts per build.
 *
 * Both builds must be the CLI-processed modules (`shopify app function build` runs the trampoline, which the runner
 * needs). Inputs come from the Rust tests: `DUMP_FUNCTION_INPUTS=<dir> cargo test --workspace` writes every input to
 * `<dir>/<crate>/<test>-<n>.json` (plus the committed stress fixture).
 *
 * Usage:
 *   FUNCTION_RUNNER=<path/to/function-runner> node scripts/compare-function-outputs.mjs \
 *     --baseline <repo root of the baseline build> [--candidate <repo root, default cwd>] --inputs <dump dir> \
 *     [--budget 11000000] [--concurrency 4]
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    runner: { type: "string" },
    baseline: { type: "string" },
    candidate: { type: "string", default: process.cwd() },
    inputs: { type: "string" },
    budget: { type: "string", default: "11000000" },
    concurrency: { type: "string", default: "4" },
  },
});
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
if (!runner || !options.baseline || !options.inputs) {
  console.error("Usage: FUNCTION_RUNNER=<path> node scripts/compare-function-outputs.mjs --baseline <root> --inputs <dir> [--candidate <root>]");
  process.exit(2);
}
const budget = Number(options.budget);
const concurrency = Number(options.concurrency);

const functions = [
  { extension: "discount-function", exportName: "cart_lines_discounts_generate_run" },
  { extension: "code-discount-function", exportName: "cart_lines_discounts_generate_run" },
  { extension: "delivery-discount-function", exportName: "cart_delivery_options_discounts_generate_run" },
];
const wasmPath = (root, extension) =>
  join(resolve(root), "apps/shopify-admin/extensions", extension, "target/wasm32-wasip1/release", `promo-engine-${extension}.wasm`);

function run(wasm, exportName, input) {
  return new Promise((resolveRun) => {
    execFile(
      runner,
      ["-f", wasm, "-i", input, "-e", exportName, "-j"],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolveRun({ failed: true, message: (stderr || error.message).trim() });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolveRun({ failed: false, output: parsed.output, instructions: parsed.instructions, logs: parsed.logs });
        } catch {
          resolveRun({ failed: true, message: `unparseable runner output: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}` });
        }
      },
    );
  });
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

const stable = (value) => JSON.stringify(value);
let mismatches = 0;
let overBudget = 0;
for (const { extension, exportName } of functions) {
  const directory = join(resolve(options.inputs), `promo-engine-${extension}`);
  const recorded = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const files = recorded.map((file) => ({ file, input: join(directory, file) }));
  if (extension !== "delivery-discount-function") {
    const stress = "apps/shopify-admin/extensions/discount-function/src/fixtures/stress-120-offers-100-lines.input.json";
    files.push({ file: "stress-120-offers-100-lines.input.json", input: join(resolve(options.candidate), stress) });
  }
  if (files.length === 0) {
    console.warn(`[compare] ${extension}: no inputs in ${directory}`);
    continue;
  }
  const rows = await pool(files, async ({ file, input }) => {
    const [base, candidate] = await Promise.all([
      run(wasmPath(options.baseline, extension), exportName, input),
      run(wasmPath(options.candidate, extension), exportName, input),
    ]);
    const same = base.failed || candidate.failed
      ? base.failed === candidate.failed && base.message === candidate.message
      : stable(base.output) === stable(candidate.output) && base.logs === candidate.logs;
    return { file, base, candidate, same };
  });
  const bad = rows.filter((row) => !row.same);
  mismatches += bad.length;
  const measured = rows.filter((row) => !row.base.failed && !row.candidate.failed);
  const peak = (key) => Math.max(0, ...measured.map((row) => row[key].instructions));
  const total = (key) => measured.reduce((sum, row) => sum + row[key].instructions, 0);
  console.info(
    `[compare] ${extension}: ${rows.length} inputs, ${bad.length} output mismatches, ${rows.length - measured.length} errored (identically). ` +
      `instructions baseline peak ${peak("base")} / candidate peak ${peak("candidate")}, total ${total("base")} -> ${total("candidate")}`,
  );
  const heaviest = [...measured].sort((a, b) => b.base.instructions - a.base.instructions).slice(0, 5);
  for (const row of heaviest) {
    const flag = row.candidate.instructions > budget ? "OVER BUDGET" : "ok";
    if (row.candidate.instructions > budget) overBudget += 1;
    console.info(`  ${String(row.base.instructions).padStart(10)} -> ${String(row.candidate.instructions).padStart(10)}  ${flag}  ${row.file}`);
  }
  for (const row of bad.slice(0, 10)) {
    console.error(`  MISMATCH ${row.file}\n    baseline:  ${stable(row.base.output ?? row.base.message).slice(0, 300)}\n    candidate: ${stable(row.candidate.output ?? row.candidate.message).slice(0, 300)}`);
  }
}
if (overBudget > 0) {
  console.warn(`[compare] ${overBudget} of the heaviest inputs exceed the ${budget} instruction budget (informational: compare against the baseline column).`);
}
if (mismatches > 0) {
  console.error(`[compare] ${mismatches} output mismatch(es)`);
  process.exit(1);
}
console.info("[compare] outputs identical");
