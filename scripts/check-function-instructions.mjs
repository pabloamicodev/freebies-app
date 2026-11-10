/**
 * Instruction-ceiling gate for the discount Functions. Shopify allows 11,000,000 wasm instructions per run for carts of
 * up to 200 lines. For each anonymized live-config spec in
 * apps/shopify-admin/extensions/discount-function/src/fixtures/instructions/ this generates deterministic carts of
 * 1..200 lines (`plain` = random sample products; `promo` = gift lines first, then the offers' promo products with landing
 * attributes, then filler), runs the CLI-built (trampolined) discount and code-discount modules through the Shopify
 * function-runner and FAILS if any run exceeds the limit. Above the warning line it only warns. The synthetic
 * stress fixture is reported, never enforced.
 *
 * Usage (after `pnpm shopify:build` or `shopify app function build`):
 *   FUNCTION_RUNNER=<function-runner binary> node scripts/check-function-instructions.mjs \
 *     [--runner <path>] [--limit 11000000] [--warn 8000000] [--dump-inputs <dir>]
 * `--dump-inputs` writes every generated input so compare-function-outputs.mjs can replay them.
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
  },
});
const LIMIT = Number(options.limit);
const WARN = Number(options.warn);
const SIZES = [1, 5, 10, 25, 50, 100, 200];
const root = resolve(import.meta.dirname, "..");
const extensions = join(root, "apps/shopify-admin/extensions");
const specsDir = join(extensions, "discount-function/src/fixtures/instructions");
const stressInput = join(extensions, "discount-function/src/fixtures/stress-120-offers-100-lines.input.json");
const modules = [
  ["discount", join(extensions, "discount-function/target/wasm32-wasip1/release/promo-engine-discount-function.wasm")],
  ["code", join(extensions, "code-discount-function/target/wasm32-wasip1/release/promo-engine-code-discount-function.wasm")],
];
const runner = options.runner ?? process.env.FUNCTION_RUNNER;
if (!runner || !existsSync(runner)) {
  console.error(`[instructions] function-runner not found (${runner ?? "unset"}): pass --runner or set FUNCTION_RUNNER`);
  process.exit(2);
}
for (const [, path] of modules) {
  if (!existsSync(path)) {
    console.error(`[instructions] missing ${path}: build the Functions first (pnpm shopify:build)`);
    process.exit(2);
  }
}

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (items) => items[Math.floor(rnd() * items.length)];
const gidOf = (value, type) => (String(value).startsWith("gid") ? String(value) : `gid://shopify/${type}/${value}`);
const idList = (value) => (typeof value === "string" ? value.split(",").filter(Boolean) : (value ?? []));

function buildInput(spec, size, mix) {
  seed = 42;
  const { config } = spec;
  const giftOffers = config.offers.filter((offer) => offer.giftRewards?.length);
  const lines = [];
  let count = 0;
  const add = (item, extra = {}) => {
    const quantity = extra.quantity ?? 1 + Math.floor(rnd() * 3);
    lines.push({
      id: `gid://shopify/CartLine/${++count}`,
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
    });
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
      if (lines.length >= Math.max(1, Math.floor(size / 4))) break;
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
    while (lines.length < size && pool.length && index < Math.max(pool.length, Math.ceil(size / 2))) {
      add(pool[index % pool.length], {
        landing: spec.landingValues.length ? spec.landingValues[index % spec.landingValues.length] : null,
      });
      index++;
    }
  }
  while (lines.length < size) add(pick(spec.sample));
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

function instructions(wasm, inputPath) {
  try {
    const out = execFileSync(
      runner,
      ["-f", wasm, "-i", inputPath, "-e", "cart_lines_discounts_generate_run", "-j"],
      { maxBuffer: 1 << 28 },
    );
    return JSON.parse(out.toString()).instructions;
  } catch (error) {
    return `ERR ${String(error.stderr ?? error.message).slice(0, 120)}`;
  }
}

const dumpDir = options["dump-inputs"] ? resolve(options["dump-inputs"]) : null;
const scratch = dumpDir ?? join(root, "node_modules/.cache/function-instructions");
mkdirSync(scratch, { recursive: true });
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
      const inputPath = join(scratch, `${fixture}-${String(size).padStart(3, "0")}-${mix}.json`);
      writeFileSync(inputPath, JSON.stringify(buildInput(spec, size, mix)));
      for (const [name, wasm] of modules) {
        rows.push({ fixture, size, mix, module: name, count: instructions(wasm, inputPath), enforced: true });
      }
    }
  }
}
for (const [name, wasm] of modules) {
  rows.push({ fixture: "stress-120-offers-100-lines", size: 100, mix: "synthetic", module: name, count: instructions(wasm, stressInput), enforced: false });
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
const worst = Math.max(...rows.filter((row) => row.enforced && typeof row.count === "number").map((row) => row.count));
console.info(`[instructions] worst realistic run: ${worst} / ${LIMIT} (${((100 * worst) / LIMIT).toFixed(1)}%)`);
if (failed) {
  console.error(`[instructions] FAIL: a realistic run exceeds ${LIMIT} instructions (or did not run)`);
  process.exit(1);
}
