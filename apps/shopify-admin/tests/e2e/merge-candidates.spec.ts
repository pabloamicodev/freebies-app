/**
 * mergeCandidates dev-store proof, PREPARED AND NOT RUN: pending owner OK for a Functions deploy (hpn-test-store shares
 * the promo-engine-hpn app with production HPN and TRU, so the Functions that read the flag must be deployed first).
 *
 * Needs the offers of `pnpm tsx scripts/seed-merge-candidates-e2e.ts seed`, which writes fixtures/merge-candidates-seed.json;
 * without that marker the whole file is skipped, so a normal E2E run is unaffected. One 15% sitewide offer covers five
 * products, so a cart holding all of them makes the Function emit five identical adjacent candidates, which the flag folds
 * into one.
 *
 * Run it once per flag state (the flag is flipped server side with the seed script, not from the browser):
 *   MERGE_E2E_STATE=off playwright test tests/e2e/merge-candidates.spec.ts
 *   pnpm tsx scripts/seed-merge-candidates-e2e.ts flag on
 *   MERGE_E2E_STATE=on  playwright test tests/e2e/merge-candidates.spec.ts
 * Each run records the cart it saw in fixtures/merge-candidates-result-<state>.json; the "on" run (and any later run) also
 * compares both files: per line, the final price and the discount titles must be identical, and so must the cart total.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

import { addLines, clearCart, discountTitles, getCart, gotoStorefront, waitForPromoEngine, type Cart } from "./helpers/storefront.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MARKER = path.join(FIXTURES, "merge-candidates-seed.json");
const resultFile = (state: string) => path.join(FIXTURES, `merge-candidates-result-${state}.json`);

interface SeedProduct {
  handle: string;
  variantId: string;
  price: number;
}
interface Seed {
  percent: number;
  products: SeedProduct[];
}
interface Recorded {
  state: string;
  total_discount: number;
  total_price: number;
  lines: Array<{ variant: number; quantity: number; original: number; final: number; titles: string[] }>;
}

const seed: Seed | null = existsSync(MARKER) ? (JSON.parse(readFileSync(MARKER, "utf8")) as Seed) : null;
const state = process.env["MERGE_E2E_STATE"] === "on" ? "on" : "off";
const variantNumber = (gid: string) => Number(gid.split("/").pop());
const TOLERANCE_CENTS = 2;

async function settledCart(page: Page): Promise<Cart & { total_discount: number; total_price: number }> {
  let last = "";
  let stable = 0;
  let cart = (await getCart(page)) as Cart & { total_discount: number; total_price: number };
  for (let attempt = 0; attempt < 20 && stable < 2; attempt++) {
    await page.waitForTimeout(2_000);
    cart = (await getCart(page)) as Cart & { total_discount: number; total_price: number };
    const fingerprint = JSON.stringify(cart.items.map((line) => [line.variant_id, line.quantity, line.final_line_price]));
    stable = fingerprint === last ? stable + 1 : 0;
    last = fingerprint;
  }
  return cart;
}

test.describe(`mergeCandidates on hpn-test-store (flag ${state})`, () => {
  test.skip(!seed, "No merge-candidates seed marker: run scripts/seed-merge-candidates-e2e.ts seed first.");

  test("a cart of every seeded product gets the same discounts whatever the flag says", async ({ page }) => {
    const { products, percent } = seed!;
    await gotoStorefront(page, `/products/${encodeURIComponent(products[0]!.handle)}`);
    await waitForPromoEngine(page);
    await clearCart(page);
    await addLines(page, products.map((product, index) => ({ id: variantNumber(product.variantId), quantity: 1 + (index % 2) })));
    const cart = await settledCart(page);

    for (const line of cart.items) {
      const expected = Math.round((line.original_line_price * percent) / 100);
      expect(Math.abs(line.original_line_price - line.final_line_price - expected), `variant ${line.variant_id}`).toBeLessThanOrEqual(TOLERANCE_CENTS);
    }

    const recorded: Recorded = {
      state,
      total_discount: cart.total_discount,
      total_price: cart.total_price,
      lines: cart.items.map((line) => ({
        variant: line.variant_id,
        quantity: line.quantity,
        original: line.original_line_price,
        final: line.final_line_price,
        titles: discountTitles(line).sort(),
      })),
    };
    writeFileSync(resultFile(state), `${JSON.stringify(recorded, null, 2)}\n`);
    await test.info().attach(`cart-${state}.json`, { body: JSON.stringify({ cart, recorded }, null, 2), contentType: "application/json" });

    const other = state === "on" ? "off" : "on";
    if (existsSync(resultFile(other))) {
      const before = JSON.parse(readFileSync(resultFile(other), "utf8")) as Recorded;
      expect(recorded.total_discount, "cart total discount").toBe(before.total_discount);
      expect(recorded.total_price, "cart total price").toBe(before.total_price);
      expect(recorded.lines, "per line price and discount titles").toEqual(before.lines);
    }
  });
});
