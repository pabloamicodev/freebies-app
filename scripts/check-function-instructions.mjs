/**
 * Instruction-ceiling gate for the discount Functions. Shopify allows 11,000,000 wasm instructions per run for carts of
 * up to 200 lines. For each anonymized live-config spec in
 * apps/shopify-admin/extensions/discount-function/src/fixtures/instructions/ this generates deterministic carts of
 * 1..200 lines (`plain` = random sample products; `promo` = gift lines first, then the offers' promo products with landing
 * attributes, then filler), runs the CLI-built (trampolined) discount and code-discount modules through the Shopify
 * function-runner and FAILS if any run exceeds the limit. The delivery Function runs the same carts against a shipping
 * config built from the spec (sitewide tiers, page conditions, reject mode, landing anchors, quiz bundle). Above the
 * warning line it only warns. The synthetic stress fixture is reported, never enforced.
 *
 * Usage (after `pnpm shopify:build` or `shopify app function build`):
 *   FUNCTION_RUNNER=<function-runner binary> node scripts/check-function-instructions.mjs \
 *     [--runner <path>] [--limit 11000000] [--warn 8000000] [--dump-inputs <dir>] [--summary]
 * `--dump-inputs` writes every generated input to <dir>/promo-engine-<extension>/ so compare-function-outputs.mjs
 * (--inputs <dir>) can replay them. `--summary` prints the worst run per spec, module and cart size.
 * Exit 1: a realistic run is over the limit or failed. Exit 2: the runner or a wasm module is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: {
    runner: { type: "string" },
    limit: { type: "string", default: "11000000" },
    warn: { type: "string", default: "8000000" },
    "dump-inputs": { type: "string" },
    summary: { type: "boolean", default: false },
  },
});
const LIMIT = Number(options.limit);
const WARN = Number(options.warn);
const SIZES = [1, 5, 10, 25, 50, 100, 200];
const SUMMARY_SIZES = [50, 100, 200];
const root = resolve(import.meta.dirname, "..");
const extensions = join(root, "apps/shopify-admin/extensions");
const specsDir = join(extensions, "discount-function/src/fixtures/instructions");
const stressInput = join(extensions, "discount-function/src/fixtures/stress-120-offers-100-lines.input.json");
const wasmOf = (extension) => join(extensions, extension, "target/wasm32-wasip1/release", `promo-engine-${extension}.wasm`);
const modules = [
  { name: "discount", extension: "discount-function", exportName: "cart_lines_discounts_generate_run", delivery: false },
  { name: "code", extension: "code-discount-function", exportName: "cart_lines_discounts_generate_run", delivery: false },
  { name: "delivery", extension: "delivery-discount-function", exportName: "cart_delivery_options_discounts_generate_run", delivery: true },
].map((module) => ({ ...module, wasm: wasmOf(module.extension) }));
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
if (!runner || !existsSync(runner)) {
  console.error(`[instructions] function-runner not found (${runner ?? "unset"}): pass --runner or set FUNCTION_RUNNER`);
  process.exit(2);
}
for (const { wasm } of modules) {
  if (!existsSync(wasm)) {
    console.error(`[instructions] missing ${wasm}: build the Functions first (pnpm shopify:build)`);
    process.exit(2);
  }
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (items) => items[Math.floor(rnd() * items.length)];
const gidOf = (value, type) => (String(value).startsWith("gid") ? String(value) : `gid://shopify/${type}/${value}`);
const idList = (value) => (typeof value === "string" ? value.split(",").filter(Boolean) : (value ?? []));

// The cart as (item, quantity, extras) picks: both Function shapes are built from the same picks, so a spec always
// produces the same cart whichever module reads it.
function pickLines(spec, size, mix) {
  seed = 42;
  const { config } = spec;
  const giftOffers = config.offers.filter((offer) => offer.giftRewards?.length);
  const picks = [];
  const add = (item, extra = {}) => {
    picks.push({ item, extra, quantity: extra.quantity ?? 1 + Math.floor(rnd() * 3) });
  };
  if (mix === "promo") {
    const giftVariants = new Set(
      giftOffers.flatMap((offer) =>
        offer.giftRewards.flatMap((gift) => idList(gift.targetVariantIds).map((id) => gidOf(id, "ProductVariant"))),
      ),
    );
    const pool = spec.promo.filter((item) => !giftVariants.has(item.v));
    // Gift lines first (as the storefront adds them), at most one per gift offer, then qualifying products, then filler.
    for (const offer of giftOffers) {
      if (picks.length >= Math.max(1, Math.floor(size / 4))) break;
      const gift = offer.giftRewards[0];
      const variant = idList(gift.targetVariantIds)[0];
      if (!variant) continue;
      add(
        { v: gidOf(variant, "ProductVariant"), p: "gid://shopify/Product/1", price: 10, tiers: null },
        {
          quantity: 1,
          lineType: "gift",
          meta: {
            _promo_page_url: "/",
            _promo_engine_offer_id: offer.id,
            _promo_engine_reward_id: gift.id,
            _promo_engine_offer_version: String(offer.version),
          },
        },
      );
    }
    let index = 0;
    while (picks.length < size && pool.length && index < Math.max(pool.length, Math.ceil(size / 2))) {
      add(pool[index % pool.length], {
        landing: spec.landingValues.length ? spec.landingValues[index % spec.landingValues.length] : null,
      });
      index++;
    }
  }
  while (picks.length < size) add(pick(spec.sample));
  return picks;
}

function buildDiscountInput(spec, size, mix) {
  const { config } = spec;
  const lines = pickLines(spec, size, mix).map(({ item, extra, quantity }, index) => ({
    id: `gid://shopify/CartLine/${index + 1}`,
    quantity,
    cost: { subtotalAmount: { amount: (item.price * quantity).toFixed(2) } },
    sellingPlanAllocation: null,
    merchandise: {
      __typename: "ProductVariant",
      id: item.v,
      product: { id: item.p, volumeDiscountTiers: item.tiers ? { value: item.tiers } : null },
    },
    lineType: extra.lineType ? { value: extra.lineType } : null,
    landingSource: extra.landing ? { value: extra.landing } : null,
    volumeDiscountBundleItem: null,
    volumeDiscountNektarGlp1: null,
    promoMetadata: { value: JSON.stringify(extra.meta ?? { _promo_page_url: "/" }) },
  }));
  return {
    cart: {
      customCart1: null,
      customCart2: null,
      customCart3: null,
      buyerIdentity: {
        customer: {
          numberOfOrders: 3,
          hasTags: (config.customerTags ?? []).map((tag) => ({ tag, hasTag: false })),
          amountSpent: { amount: "250.0" },
          usage: null,
        },
      },
      lines,
      cost: { subtotalAmount: { currencyCode: spec.currency ?? "USD" } },
    },
    discount: { metafield: { value: JSON.stringify(config) } },
    enteredDiscountCodes: [],
    presentmentCurrencyRate: "1",
    localization: { country: { isoCode: "US" } },
  };
}

function deliveryConfig(spec) {
  const currencyCode = spec.currency ?? "USD";
  const tiers = [
    { minimumSubtotalCents: 5000, discountType: "percentage", discountValue: 50 },
    { minimumSubtotalCents: 10000, discountType: "free", discountValue: 100 },
  ];
  const pageConditions = spec.config.offers.find((offer) => offer.pageUrlConditions?.length)?.pageUrlConditions ?? [
    { patterns: ["/pages/offer"], matchMode: "starts_with" },
  ];
  const anchors = spec.promo.slice(0, 3).map((item) => item.v);
  return {
    shippingOffers: [
      { id: "ship-sitewide:r1", priority: 1, scopeMode: "sitewide", tiers, currencyCode },
      { id: "ship-pages:r2", priority: 2, scopeMode: "sitewide", tiers, pageUrlConditions: pageConditions, currencyCode },
      { id: "ship-reject:r3", priority: 3, scopeMode: "sitewide", tiers, pageUrlConditions: pageConditions, rejectUnmatchedLines: true, currencyCode },
      {
        id: "ship-landing:r4",
        priority: 4,
        scopeMode: "landing",
        requiredLineAttributeValue: spec.landingValues[0] ?? "landing",
        requiredAnchorVariantIds: anchors,
        requiredAnchorMinQuantity: 1,
        tiers,
        currencyCode,
      },
      { id: "ship-quiz:r5", priority: 5, scopeMode: "quiz_bundle", tiers, currencyCode },
    ],
  };
}

function buildDeliveryInput(spec, size, mix) {
  const currencyCode = spec.currency ?? "USD";
  let subtotal = 0;
  const lines = pickLines(spec, size, mix).map(({ item, extra, quantity }) => {
    subtotal += item.price * quantity;
    return {
      quantity,
      cost: { subtotalAmount: { amount: (item.price * quantity).toFixed(2), currencyCode } },
      lineTypeAttribute: extra.lineType ? { value: extra.lineType } : null,
      cartGiftTierAttribute: null,
      landingSourceAttribute: extra.landing ? { value: extra.landing } : null,
      quizBundleIdAttribute: null,
      quizFreeGiftAttribute: null,
      quizExpectedPaidCountAttribute: null,
      promoMetadata: { value: JSON.stringify(extra.meta ?? { _promo_page_url: "/" }) },
      sellingPlanAllocation: null,
      merchandise: { __typename: "ProductVariant", id: item.v },
    };
  });
  return {
    presentmentCurrencyRate: "1.0",
    enteredDiscountCodes: [],
    discount: { discountClasses: ["SHIPPING"], metafield: { value: JSON.stringify(deliveryConfig(spec)) } },
    cart: {
      buyerIdentity: { customer: { usage: null } },
      cost: { subtotalAmount: { amount: subtotal.toFixed(2), currencyCode } },
      lines,
      deliveryGroups: [
        {
          id: "gid://shopify/CartDeliveryGroup/1",
          groupType: "ONE_TIME_PURCHASE",
          cartLines: lines.map(() => ({ sellingPlanAllocation: null })),
        },
      ],
    },
  };
}

function instructions({ wasm, exportName }, inputPath) {
  try {
    const out = execFileSync(runner, ["-f", wasm, "-i", inputPath, "-e", exportName, "-j"], { maxBuffer: 1 << 28 });
    return JSON.parse(out.toString()).instructions;
  } catch (error) {
    return `ERR ${String(error.stderr ?? error.message).slice(0, 120)}`;
  }
}

const dumpDir = options["dump-inputs"] ? resolve(options["dump-inputs"]) : null;
const scratch = dumpDir ?? join(root, "node_modules/.cache/function-instructions");
const inputDirs = new Map(
  modules.map((module) => {
    const directory = join(scratch, `promo-engine-${module.extension}`);
    mkdirSync(directory, { recursive: true });
    return [module.name, directory];
  }),
);
const rows = [];
for (const file of readdirSync(specsDir).filter((name) => name.endsWith(".json")).sort()) {
  const fixture = file.replace(".json", "");
  const spec = JSON.parse(readFileSync(join(specsDir, file), "utf8"));
  const hasPromo =
    spec.promo.length > 0 ||
    spec.landingValues.length > 0 ||
    spec.config.offers.some((offer) => offer.giftRewards?.length);
  for (const size of SIZES) {
    for (const mix of ["plain", "promo"]) {
      if (mix === "promo" && !hasPromo) continue;
      const name = `${fixture}-${String(size).padStart(3, "0")}-${mix}.json`;
      const built = new Map();
      for (const module of modules) {
        const kind = module.delivery ? "delivery" : "discount";
        if (!built.has(kind)) built.set(kind, JSON.stringify(module.delivery ? buildDeliveryInput(spec, size, mix) : buildDiscountInput(spec, size, mix)));
        const inputPath = join(inputDirs.get(module.name), name);
        writeFileSync(inputPath, built.get(kind));
        rows.push({ fixture, size, mix, module: module.name, count: instructions(module, inputPath), enforced: true });
      }
    }
  }
}
for (const module of modules.filter((candidate) => !candidate.delivery)) {
  rows.push({ fixture: "stress-120-offers-100-lines", size: 100, mix: "synthetic", module: module.name, count: instructions(module, stressInput), enforced: false });
}

let failed = false;
console.info(
  ["fixture".padEnd(30), "lines".padStart(5), "mix".padEnd(9), "module".padEnd(8), "instructions".padStart(13), "% of limit".padStart(10)].join(" "),
);
for (const row of rows) {
  const numeric = typeof row.count === "number";
  const percent = numeric ? `${((100 * row.count) / LIMIT).toFixed(1)}%` : "-";
  let flag = "";
  if (row.enforced && (!numeric || row.count > LIMIT)) {
    failed = true;
    flag = "  FAIL";
  } else if (row.enforced && row.count > WARN) flag = "  warn";
  else if (!row.enforced) flag = "  (report only)";
  console.info(
    [row.fixture.padEnd(30), String(row.size).padStart(5), row.mix.padEnd(9), row.module.padEnd(8), String(row.count).padStart(13), percent.padStart(10)].join(" ") + flag,
  );
}
const counts = rows.filter((row) => row.enforced && typeof row.count === "number").map((row) => row.count);
if (counts.length === 0) {
  console.error("[instructions] FAIL: no realistic run produced an instruction count");
  process.exit(1);
}
const worst = Math.max(...counts);
console.info(`[instructions] worst realistic run: ${worst} / ${LIMIT} (${((100 * worst) / LIMIT).toFixed(1)}%)`);
if (options.summary) {
  const specs = [...new Set(rows.filter((row) => row.enforced).map((row) => row.fixture))];
  console.info(`\n| spec | module | ${SUMMARY_SIZES.map((size) => `${size} lines`).join(" | ")} |\n|---|---|${SUMMARY_SIZES.map(() => "---:").join("|")}|`);
  for (const fixture of specs) {
    for (const module of modules) {
      const cells = SUMMARY_SIZES.map((size) => {
        const found = rows.filter((row) => row.enforced && row.fixture === fixture && row.module === module.name && row.size === size);
        const numeric = found.map((row) => row.count).filter((count) => typeof count === "number");
        return numeric.length ? String(Math.max(...numeric)) : "-";
      });
      console.info(`| ${fixture} | ${module.name} | ${cells.join(" | ")} |`);
    }
  }
}
if (failed) {
  console.error(`[instructions] FAIL: a realistic run exceeds ${LIMIT} instructions (or did not run)`);
  process.exit(1);
}
