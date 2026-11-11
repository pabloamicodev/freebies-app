/**
 * FIX-capinc canary: after "Offer fewer gifts" cut a 734-option gift picker to its top 100, a gift that survived the cut is
 * discounted in the cart. Needs scripts/seed-cap71-e2e.ts (writes fixtures/cap71-seed.json); skipped without that marker.
 * The gift line is added with the properties the storefront runtime sets, since the picker UI is not under test here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { addLines, clearCart, getCart, gotoStorefront, waitForPromoEngine } from "./helpers/storefront.js";

const MARKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cap71-seed.json");
interface Seed {
  offerId: string;
  rewardId: string;
  anchorVariantId: string;
  giftVariantId?: string;
}
const seed: Seed | null = existsSync(MARKER) ? (JSON.parse(readFileSync(MARKER, "utf8")) as Seed) : null;
const num = (gid: string) => Number(gid.split("/").pop());

test.describe("FIX-capinc gift picker cut to top-N", () => {
  test.skip(!seed || !seed.giftVariantId, "No cap71 seed marker.");

  test("a gift kept by the cut is free while the offer is active", async ({ page }) => {
    await gotoStorefront(page, "/products/30-days-to-better-energy-ebook");
    await waitForPromoEngine(page);
    await clearCart(page);
    await addLines(page, [
      { id: num(seed!.anchorVariantId), quantity: 1 },
      {
        id: num(seed!.giftVariantId!),
        quantity: 1,
        properties: {
          _promo_engine_line_type: "gift",
          _promo_engine_offer_id: seed!.offerId,
          _promo_engine_reward_id: seed!.rewardId,
        },
      },
    ]);
    let gift: { original_line_price: number; final_line_price: number } | undefined;
    for (let i = 0; i < 15; i++) {
      const cart = await getCart(page);
      gift = cart.items.find((l) => l.properties?.["_promo_engine_line_type"] === "gift");
      if (gift && gift.final_line_price === 0) break;
      await page.waitForTimeout(2_000);
    }
    console.info(`[cap71] gift line: ${JSON.stringify(gift)}`);
    expect(gift, "gift line present").toBeTruthy();
    expect(gift!.original_line_price).toBeGreaterThan(0);
    expect(gift!.final_line_price, "gift discounted to free").toBe(0);
  });
});
