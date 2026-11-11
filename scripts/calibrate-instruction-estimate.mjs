/**
 * Regenerates the CALIBRATED block of apps/shopify-admin/app/lib/sync/instruction-estimate.ts from measurements of the
 * built discount Function (CLI-processed module, so function-runner can run it) and documents the fit error.
 *
 * What it measures, per offer shape (see `offerShape`): the offer alone in a node, on carts of 25/50/100/200 lines,
 * minus the empty-config run at the same size. Samples are the offers of the anonymized live specs on the carts
 * check-function-instructions.mjs generates, the offers of the synthetic stress fixture (its cart cut to the same sizes)
 * and one hand-built order offer. Per shape it fits cost(L) = a + b * L through the per-size maximum and lifts `a` until
 * the line is at or above every sample, so the estimate never undershoots a measurement. Finally it checks every live
 * spec node (all its offers together) against the model and writes the measured nodes next to the module, where the
 * vitest suite compares them with the estimate.
 *
 * Usage:
 *   node scripts/check-function-instructions.mjs --dump-inputs <dir>      (builds the carts; needs the built modules)
 *   FUNCTION_RUNNER=<function-runner> node scripts/calibrate-instruction-estimate.mjs --inputs <dir> \
 *     [--wasm <CLI-built discount module>] [--write]
 * Without --write it only prints the table.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INSTRUCTION_LINES, offerShape } from "../apps/shopify-admin/app/lib/sync/instruction-estimate.ts";

const { values: options } = parseArgs({
  options: {
    runner: { type: "string" },
    inputs: { type: "string" },
    wasm: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const root = resolve(import.meta.dirname, "..");
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
const wasm =
  options.wasm ??
  join(root, "apps/shopify-admin/extensions/discount-function/target/wasm32-wasip1/release/promo-engine-discount-function.wasm");
if (!runner || !existsSync(runner) || !options.inputs || !existsSync(wasm)) {
  console.error("Usage: FUNCTION_RUNNER=<path> node scripts/calibrate-instruction-estimate.mjs --inputs <dump dir> [--wasm <module>] [--write]");
  process.exit(2);
}
const inputsDir = join(resolve(options.inputs), "promo-engine-discount-function");
const specsDir = join(root, "apps/shopify-admin/extensions/discount-function/src/fixtures/instructions");
const stressPath = join(root, "apps/shopify-admin/extensions/discount-function/src/fixtures/stress-120-offers-100-lines.input.json");
const modulePath = join(root, "apps/shopify-admin/app/lib/sync/instruction-estimate.ts");
const measuredPath = join(root, "apps/shopify-admin/app/lib/sync/instruction-estimate.measured.json");
const SIZES = [25, 50, 100, 200];
const scratch = mkdtempSync(join(tmpdir(), "instruction-estimate-"));
let counter = 0;

function run(input) {
  const path = join(scratch, `in-${counter++}.json`);
  writeFileSync(path, JSON.stringify(input));
  const out = execFileSync(runner, ["-f", wasm, "-i", path, "-e", "cart_lines_discounts_generate_run", "-j"], { maxBuffer: 1 << 28 });
  return JSON.parse(out.toString()).instructions;
}
const withOffers = (input, offers) => {
  const config = JSON.parse(input.discount.metafield.value);
  return { ...input, discount: { ...input.discount, metafield: { value: JSON.stringify({ ...config, offers }) } } };
};
const configOf = (input) => JSON.parse(input.discount.metafield.value);

// carts: [{ label, size, input }]
const carts = [];
const specs = readdirSync(specsDir).filter((name) => name.endsWith(".json")).map((name) => name.replace(".json", ""));
for (const spec of specs) {
  for (const size of SIZES) {
    for (const mix of ["plain", "promo"]) {
      const path = join(inputsDir, `${spec}-${String(size).padStart(3, "0")}-${mix}.json`);
      if (existsSync(path)) carts.push({ label: `${spec}-${mix}`, spec, size, input: JSON.parse(readFileSync(path, "utf8")) });
    }
  }
}
const stress = JSON.parse(readFileSync(stressPath, "utf8"));
for (const size of SIZES) {
  carts.push({ label: "stress", spec: "stress", size, input: { ...stress, cart: { ...stress.cart, lines: stress.cart.lines.slice(0, size) } } });
}

// sample offers: { shape, label, offer, on: predicate(cart) }
const samples = [];
for (const spec of specs) {
  const config = JSON.parse(readFileSync(join(specsDir, `${spec}.json`), "utf8")).config;
  config.offers.forEach((offer, index) => samples.push({ label: `${spec}#${index}`, source: "live", offer, on: (cart) => cart.spec === spec }));
}
configOf(stress).offers.forEach((offer, index) => samples.push({ label: `stress#${index}`, source: "stress", offer, on: (cart) => cart.spec === "stress" }));
const tru = JSON.parse(readFileSync(join(specsDir, "tru-slot0.json"), "utf8")).config.offers[0];
const orderOffer = {
  ...tru,
  id: "00000000-0000-4000-8000-0000000000aa",
  productRewards: [],
  pageUrlConditions: undefined,
  cartQuantityThreshold: undefined,
  orderRewards: [
    {
      id: "order-1",
      discountType: "percentage",
      discountValue: 0,
      subtotalTiers: [
        { minimumSubtotalCents: 1000, maximumSubtotalCents: 20000, discountType: "percentage", discountValue: 5 },
        { minimumSubtotalCents: 20001, discountType: "percentage", discountValue: 10 },
      ],
    },
  ],
};
samples.push({ label: "synthetic-order", source: "live", offer: orderOffer, on: (cart) => cart.spec === "tru-slot0" });

const floors = new Map();
const floorOf = (cart) => {
  const key = `${cart.label}-${cart.size}`;
  if (!floors.has(key)) floors.set(key, run(withOffers(cart.input, [])));
  return floors.get(key);
};

const raw = []; // every (shape, size, cost) for the lift
for (const sample of samples) {
  const shape = offerShape(sample.offer);
  for (const cart of carts.filter(sample.on)) {
    const cost = run(withOffers(cart.input, [sample.offer])) - floorOf(cart);
    raw.push({ shape, size: cart.size, cost, label: sample.label, source: sample.source });
  }
}

function fit(pairs) {
  const n = pairs.length;
  if (n === 0) return { a: 0, b: 0 };
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const b = sxx === 0 ? 0 : pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
  return { a: my - b * mx, b };
}
const lift = (line, samplePairs) => {
  const gap = Math.max(0, ...samplePairs.map(([x, y]) => y - (line.a + line.b * x)));
  return { a: Math.ceil(line.a + gap), b: Math.ceil(line.b) };
};

// floor: the empty-config run on every cart
const floorPairs = carts.map((cart) => [cart.size, floorOf(cart)]);
const floorLine = lift(fit(floorPairs), floorPairs);
// What a node's offers share: the first offer that looks at the lines reads every line's facts once and later offers
// reuse them. Measured with offers that read the lines and then fail (quantity floor, value floor, page that never
// matches), on every 200-line live cart; the smallest of those with a 10% margin keeps `node - shared` a safe bound.
const readers = [
  { cartQuantityThreshold: 1_000_000_000 },
  { cartValueThresholdCents: 1_000_000_000_000 },
  { pageUrlConditions: [{ patterns: ["/never-matches-anything"], matchMode: "starts_with" }] },
].map((extra, index) => ({ ...tru, id: `00000000-0000-4000-8000-0000000000b${index}`, productRewards: [], giftRewards: [], offerType: "discount", pageUrlConditions: undefined, cartQuantityThreshold: undefined, cartValueThresholdCents: undefined, ...extra }));
const readerCosts = readers.flatMap((offer) =>
  carts.filter((cart) => cart.size === INSTRUCTION_LINES && cart.spec !== "stress" && cart.spec !== "hpn-slot0").map((cart) => run(withOffers(cart.input, [offer])) - floorOf(cart)),
);
const shared = Math.floor(Math.min(...readerCosts) * 0.9);

// Live offers (on the live carts the gate builds) set the constants; the synthetic stress offers only fill shapes no live
// offer has, and are otherwise reported against the model below.
const shapes = {};
const lines = [];
const origin = {};
for (const shape of ["discount", "tiers", "gift", "landing", "order", "quiz"]) {
  const all = raw.filter((entry) => entry.shape === shape);
  const live = all.filter((entry) => entry.source === "live");
  const used = live.length > 0 ? live : all;
  if (used.length === 0) {
    shapes[shape] = null;
    continue;
  }
  origin[shape] = live.length > 0 ? "live" : "stress";
  const bySize = new Map();
  for (const entry of used) bySize.set(entry.size, Math.max(bySize.get(entry.size) ?? 0, entry.cost));
  const pairs = used.map((entry) => [entry.size, entry.cost]);
  const line = lift(fit([...bySize.entries()]), pairs);
  shapes[shape] = line;
  const errors = pairs.filter(([, y]) => y > 0).map(([x, y]) => (line.a + line.b * x - y) / y);
  lines.push(
    `| ${shape} | ${origin[shape]} | ${pairs.length} | ${line.a} | ${line.b} | ${Math.round(line.a + line.b * INSTRUCTION_LINES)} | +${(100 * Math.min(...errors)).toFixed(1)}% .. +${(100 * Math.max(...errors)).toFixed(1)}% |`,
  );
}
const present = Object.values(shapes).filter(Boolean);
const worst = present.reduce((a, b) => (a.a + a.b * 200 >= b.a + b.b * 200 ? a : b));
for (const shape of Object.keys(shapes)) shapes[shape] ??= { ...worst };

console.info(`floor(L) = ${floorLine.a} + ${floorLine.b} * L  (200 lines: ${Math.ceil(floorLine.a + floorLine.b * 200)}), shared = ${shared}`);
console.info("| shape | from | samples | a | b | cost at 200 | fit vs measured (min .. max over-estimate, zero-cost samples skipped) |\n|---|---|---:|---:|---:|---:|---|");
for (const line of lines) console.info(line);

// live spec nodes: all offers together, worst of plain/promo at 200 lines, against the model
const at = (line) => Math.ceil(line.a + line.b * INSTRUCTION_LINES);
const nodeFloor = at(floorLine) + shared;
const measured = {};
console.info("\n| live node | offers | measured (200 lines) | estimated | estimate / measured |\n|---|---:|---:|---:|---:|");
let undershoot = false;
for (const spec of specs) {
  const config = JSON.parse(readFileSync(join(specsDir, `${spec}.json`), "utf8")).config;
  const worstCart = carts.filter((cart) => cart.spec === spec && cart.size === INSTRUCTION_LINES);
  const total = Math.max(...worstCart.map((cart) => run(cart.input)));
  const estimate = nodeFloor + config.offers.reduce((sum, offer) => sum + Math.max(0, at(shapes[offerShape(offer)]) - shared), 0);
  measured[spec] = { offers: config.offers.length, measured: total };
  if (estimate < total) undershoot = true;
  console.info(`| ${spec} | ${config.offers.length} | ${total} | ${estimate} | ${(estimate / total).toFixed(2)} |`);
}
const stressRows = raw.filter((entry) => entry.source === "stress" && entry.size === INSTRUCTION_LINES);
const under = stressRows.filter((entry) => Math.max(0, at(shapes[entry.shape]) - shared) + shared < entry.cost).sort((a, b) => b.cost - a.cost);
console.info(`\nSynthetic stress offers at 200 lines (reported, not enforced): ${under.length} of ${stressRows.length} cost more stand-alone than their shape's estimate${under.length ? ` (worst ${under[0].label}: ${under[0].cost})` : ""}.`);
rmSync(scratch, { recursive: true, force: true });
if (undershoot) {
  console.error("[calibrate] FAIL: the model undershoots a live node");
  process.exit(1);
}
if (options.write) {
  const block = `// BEGIN calibrated
export const CALIBRATED = {
  floor: { a: ${floorLine.a}, b: ${floorLine.b} } as Line,
  shared: ${shared},
  shapes: {
${Object.entries(shapes).map(([shape, line]) => `    ${shape}: { a: ${line.a}, b: ${line.b} },`).join("\n")}
  } as Record<OfferShape, Line>,
};
// END calibrated`;
  const source = readFileSync(modulePath, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const next = source.replace(/\/\/ BEGIN calibrated[\s\S]*?\/\/ END calibrated/, block.replace(/\n/g, eol));
  writeFileSync(modulePath, next);
  writeFileSync(measuredPath, `${JSON.stringify({ lines: INSTRUCTION_LINES, wasm: "discount, worst of plain/promo carts", nodes: measured }, null, 2)}\n`);
  console.info(`[calibrate] wrote ${modulePath} and ${measuredPath}`);
}
if (process.env.CALIBRATE_DEBUG) {
  mkdirSync(scratch, { recursive: true });
  const rows = samples.map((s) => {
    const cart = carts.filter(s.on).filter((c) => c.size === 200);
    const cost = Math.max(...cart.map((c) => run(withOffers(c.input, [s.offer])) - floorOf(c)));
    const rw = (s.offer.productRewards ?? [])[0] ?? {};
    return { label: s.label, shape: offerShape(s.offer), cost, scope: rw.scopeMode, targets: (rw.targetProductIds?.length ?? 0) + (rw.targetVariantIds?.length ?? 0), page: s.offer.pageUrlConditions?.length ?? 0, thr: !!(s.offer.cartValueThresholdCents || s.offer.cartQuantityThreshold), req: s.offer.requirements?.length ?? 0, req2: (s.offer.requiredProductIds?.length ?? 0) + (s.offer.requiredVariantIds?.length ?? 0), tiers: rw.quantityTiers?.length ?? 0, gifts: s.offer.giftRewards?.length ?? 0, sel: rw.selectionMode, disc: rw.discountType };
  });
  rows.sort((a, b) => b.cost - a.cost);
  for (const r of rows.filter((_, i) => i % 6 === 0 || i < 12)) console.log(JSON.stringify(r));
}
