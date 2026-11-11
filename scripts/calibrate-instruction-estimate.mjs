/**
 * Regenerates the CALIBRATED block of apps/shopify-admin/app/lib/sync/instruction-estimate.ts from measurements of the
 * built discount Function (CLI-processed module, so function-runner can run it) and documents the fit error.
 *
 * Model, at 200 lines with every line relevant:
 *   node = floor(L) + [node has an offer] * (BASE + QTY * [some offer has a quantity floor/cap] + VALUE * [some offer has a
 *          cart value floor/cap]) + sum(own(shape(offer)))
 * The first offer of a node reads every line's facts once and later offers reuse them, so those costs are paid once per
 * node, not once per offer. BASE, QTY and VALUE are the cheapest measurements of reader-only offers (offers that read the
 * lines and then fail) over the live carts: a smaller fact cost can only push cost into `own`, so the model never undershoots.
 * own(shape) is what an offer costs beyond the facts it needs: its stand-alone cost minus the facts it uses, per shape the
 * maximum over the live samples (stress-fixture offers only fill shapes no live offer has; they are reported, not enforced).
 * floor(L) is the empty-config run, fitted over 25/50/100/200-line carts and lifted above every sample.
 *
 * It then checks every live spec node (all its offers together, worst of plain/promo at 200 lines) against the model:
 * the estimate must be at least the measurement (fails otherwise) and should be at most 1.3x (reported, fails with --strict).
 *
 * Usage:
 *   node scripts/check-function-instructions.mjs --dump-inputs <dir>      (builds the carts; needs the built modules)
 *   FUNCTION_RUNNER=<function-runner> node scripts/calibrate-instruction-estimate.mjs --inputs <dir> \
 *     [--wasm <CLI-built discount module>] [--write] [--strict]
 * Without --write it only prints the tables.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INSTRUCTION_LINES, offerFacts, offerShape, ownKey } from "../apps/shopify-admin/app/lib/sync/instruction-estimate.ts";

const { values: options } = parseArgs({
  options: {
    runner: { type: "string" },
    inputs: { type: "string" },
    wasm: { type: "string" },
    write: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});
const root = resolve(import.meta.dirname, "..");
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
const wasm =
  options.wasm ??
  join(root, "apps/shopify-admin/extensions/discount-function/target/wasm32-wasip1/release/promo-engine-discount-function.wasm");
if (!runner || !existsSync(runner) || !options.inputs || !existsSync(wasm)) {
  console.error("Usage: FUNCTION_RUNNER=<path> node scripts/calibrate-instruction-estimate.mjs --inputs <dump dir> [--wasm <module>] [--write] [--strict]");
  process.exit(2);
}
const MAX_RATIO = 1.3;
const inputsDir = join(resolve(options.inputs), "promo-engine-discount-function");
const specsDir = join(root, "apps/shopify-admin/extensions/discount-function/src/fixtures/instructions");
const stressPath = join(root, "apps/shopify-admin/extensions/discount-function/src/fixtures/stress-120-offers-100-lines.input.json");
const modulePath = join(root, "apps/shopify-admin/app/lib/sync/instruction-estimate.ts");
const measuredPath = join(root, "apps/shopify-admin/app/lib/sync/instruction-estimate.measured.json");
const SIZES = [25, 50, 100, 200];
const SHAPES = ["discount", "tiers", "gift", "landing", "order", "quiz"];
const KEYS = [...SHAPES.flatMap((shape) => [shape, `${shape}+value`]), "idle"];
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
const liveCarts200 = carts.filter((cart) => cart.size === INSTRUCTION_LINES && cart.spec !== "stress" && cart.spec !== "hpn-slot0");

const floors = new Map();
const floorOf = (cart) => {
  const key = `${cart.label}-${cart.size}`;
  if (!floors.has(key)) floors.set(key, run(withOffers(cart.input, [])));
  return floors.get(key);
};

function fit(pairs) {
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const b = sxx === 0 ? 0 : pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
  return { a: my - b * mx, b };
}
const floorPairs = carts.map((cart) => [cart.size, floorOf(cart)]);
const floorFit = fit(floorPairs);
const floorLine = {
  a: Math.ceil(floorFit.a + Math.max(0, ...floorPairs.map(([x, y]) => y - (floorFit.a + floorFit.b * x)))),
  b: Math.ceil(floorFit.b),
};
const floor200 = Math.ceil(floorLine.a + floorLine.b * INSTRUCTION_LINES);

// Fact costs: reader-only offers (they read the lines, then fail), cheapest over the live carts (VALUE is the dearest: the cart-value read grows with the cart's products, and a node whose offers share it pays it once).
const tru = JSON.parse(readFileSync(join(specsDir, "tru-slot0.json"), "utf8")).config.offers[0];
const reader = (extra) => ({
  ...tru,
  id: "00000000-0000-4000-8000-0000000000b0",
  productRewards: [],
  giftRewards: [],
  offerType: "discount",
  pageUrlConditions: undefined,
  cartQuantityThreshold: undefined,
  cartValueThresholdCents: undefined,
  ...extra,
});
const readerCost = (extra) => liveCarts200.map((cart) => run(withOffers(cart.input, [reader(extra)])) - floorOf(cart));
const none = readerCost({});
const base = Math.min(...none);
const qty = Math.min(...readerCost({ cartQuantityThreshold: 1_000_000_000 }).map((cost, i) => cost - none[i]));
const value = Math.max(...readerCost({ cartValueThresholdCents: 1_000_000_000_000 }).map((cost, i) => cost - none[i]));
const factsOf = (offer) => base + (offerFacts(offer) & 1 ? qty : 0) + (offerFacts(offer) & 2 ? value : 0);

// Samples: own cost beyond the facts, per shape.
const samples = [];
for (const spec of specs) {
  const config = JSON.parse(readFileSync(join(specsDir, `${spec}.json`), "utf8")).config;
  config.offers.forEach((offer, index) => samples.push({ label: `${spec}#${index}`, source: "live", offer, node: config.offers, on: (cart) => cart.spec === spec }));
}
JSON.parse(stress.discount.metafield.value).offers.forEach((offer, index) =>
  samples.push({ label: `stress#${index}`, source: "stress", offer, on: (cart) => cart.spec === "stress" }),
);
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

const factsUnion = (offers) =>
  offers.length === 0 ? 0 : base + (offers.some((o) => offerFacts(o) & 1) ? qty : 0) + (offers.some((o) => offerFacts(o) & 2) ? value : 0);
const own = []; // { shape, source, label, cost }
for (const sample of samples) {
  const shape = ownKey(sample.offer);
  for (const cart of carts.filter((c) => sample.on(c) && c.size === INSTRUCTION_LINES)) {
    const alone = run(withOffers(cart.input, [sample.offer])) - floorOf(cart);
    let cost = Math.max(0, alone - factsOf(sample.offer));
    if (sample.source === "live" && sample.node) {
      // Its marginal in a full live node: what removing it saves beyond the shared facts only it needed. Offers that
      // stop early cost less alone than the facts, yet still add this much next to the others.
      const others = sample.node.filter((offer) => offer !== sample.offer);
      const saved = run(withOffers(cart.input, sample.node)) - run(withOffers(cart.input, others));
      cost = Math.max(cost, saved - (factsUnion(sample.node) - factsUnion(others)));
    }
    own.push({ shape, source: sample.source, label: sample.label, cost });
  }
}
const shapes = {};
const origin = {};
const rows = [];
// Per offer the worse of its carts, per class the maximum over its live offers (stress-fixture offers only fill classes no live
// offer has): the class constant is an upper envelope, so no live node can be estimated below its measurement.
const maxOf = (entries) => {
  const byLabel = new Map();
  for (const entry of entries) byLabel.set(entry.label, Math.max(byLabel.get(entry.label) ?? 0, entry.cost));
  return Math.ceil(Math.max(...byLabel.values()));
};
for (const key of KEYS) {
  const all = own.filter((entry) => entry.shape === key);
  const live = all.filter((entry) => entry.source === "live");
  const used = live.length > 0 ? live : all;
  if (used.length === 0) continue;
  origin[key] = live.length > 0 ? "live" : "stress";
  shapes[key] = maxOf(used);
  rows.push(`| ${key} | ${origin[key]} | ${used.length} | ${Math.ceil(Math.min(...used.map((entry) => entry.cost)))} | ${shapes[key]} |`);
}
// A class with no sample (for example a quiz offer with a value floor) costs at least what the same shape costs elsewhere.
for (const key of KEYS) {
  if (key in shapes) continue;
  const sameShape = KEYS.filter((other) => other.split("+")[0] === key.split("+")[0] && other in shapes).map((other) => shapes[other]);
  shapes[key] = sameShape.length > 0 ? Math.max(...sameShape) : Math.max(...Object.values(shapes));
}

const measuredByNode = {};
for (const spec of specs) {
  measuredByNode[spec] = Math.max(...carts.filter((cart) => cart.spec === spec && cart.size === INSTRUCTION_LINES).map((cart) => run(cart.input)));
}
console.info(`floor(L) = ${floorLine.a} + ${floorLine.b} * L  (200 lines: ${floor200}); BASE = ${base}, QTY = ${qty}, VALUE = ${value}`);
console.info("\n| class | from | samples | own min | own (max, used) |\n|---|---|---:|---:|---:|");
for (const row of rows) console.info(row);

// Live nodes against the model.
const modelNode = (offers) =>
  floor200 +
  (offers.length > 0 ? base : 0) +
  (offers.some((offer) => offerFacts(offer) & 1) ? qty : 0) +
  (offers.some((offer) => offerFacts(offer) & 2) ? value : 0) +
  offers.reduce((sum, offer) => sum + shapes[ownKey(offer)], 0);
const measured = {};
let undershoot = false;
let tooLoose = false;
console.info("\n| live node | offers | measured (200 lines) | estimated | estimate / measured |\n|---|---:|---:|---:|---:|");
for (const spec of specs) {
  const config = JSON.parse(readFileSync(join(specsDir, `${spec}.json`), "utf8")).config;
  const total = measuredByNode[spec];
  const estimate = modelNode(config.offers);
  measured[spec] = { offers: config.offers.length, measured: total };
  if (estimate < total) undershoot = true;
  if (estimate / total > MAX_RATIO) tooLoose = true;
  console.info(`| ${spec} | ${config.offers.length} | ${total} | ${estimate} | ${(estimate / total).toFixed(2)} |`);
}
const stressRows = own.filter((entry) => entry.source === "stress");
const under = stressRows.filter((entry) => entry.cost > shapes[entry.shape]).sort((a, b) => b.cost - a.cost);
console.info(`\nSynthetic stress offers (reported, not enforced): ${under.length} of ${stressRows.length} cost more beyond their facts than their class's own estimate${under.length ? ` (worst ${under[0].label}: ${under[0].cost} vs ${shapes[under[0].shape]})` : ""}.`);
rmSync(scratch, { recursive: true, force: true });
if (undershoot) {
  console.error("[calibrate] FAIL: the model undershoots a live node");
  process.exit(1);
}
if (tooLoose) {
  console.error(`[calibrate] ${options.strict ? "FAIL" : "warning"}: a live node is estimated above ${MAX_RATIO}x its measurement`);
  if (options.strict) process.exit(1);
}
if (options.write) {
  const block = `// BEGIN calibrated
export const CALIBRATED = {
  floor: { a: ${floorLine.a}, b: ${floorLine.b} } as Line,
  base: ${base},
  qty: ${qty},
  value: ${value},
  shapes: {
${KEYS.map((key) => `  "${key}": ${shapes[key]},`).join("\n")}
  } as Record<string, number>,
};
// END calibrated`;
  const source = readFileSync(modulePath, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(modulePath, source.replace(/\/\/ BEGIN calibrated[\s\S]*?\/\/ END calibrated/, block.replace(/\n/g, eol)));
  writeFileSync(measuredPath, `${JSON.stringify({ lines: INSTRUCTION_LINES, wasm: "discount, worst of plain/promo carts", nodes: measured }, null, 2).replace(/\n/g, eol)}${eol}`);
  console.info(`[calibrate] wrote ${modulePath} and ${measuredPath}`);
}
