/**
 * E2E tests — Gift offer flows against hpn-test-store.
 *
 * Fixture: the active "E2E Gift Offer" (scripts/seed-ambrosia-e2e.ts). Adding its
 * anchor product auto-adds one free gift; the gift limit is the default of one set.
 * The anchor is not part of any Ambrosia rule, so the $85 subtotal offer never
 * competes with it. Carts are driven through the cart API in page context, which
 * the storefront runtime observes exactly as it observes a theme add-to-cart.
 */

import { test, expect, type Page } from "@playwright/test";

import { E2E_GIFT_ANCHOR_HANDLE } from "./fixtures/live-offers.js";
import { firstVariantId } from "./helpers/fixtures.js";
import {
  addLines,
  changeLine,
  clearCart,
  getCart,
  gotoStorefront,
  waitForPromoEngine,
  type Cart,
} from "./helpers/storefront.js";

const isGift = (item: Cart["items"][number]) => item.properties?.["_promo_engine_line_type"] === "gift";

let anchorVariant = 0;

async function openAnchorWithEmptyCart(page: Page): Promise<void> {
  await gotoStorefront(page, `/products/${encodeURIComponent(E2E_GIFT_ANCHOR_HANDLE)}`);
  await waitForPromoEngine(page);
  if (!anchorVariant) anchorVariant = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);
  await clearCart(page);
}

async function waitForGift(page: Page, present: boolean): Promise<Cart> {
  await expect
    .poll(async () => (await getCart(page)).items.some(isGift), {
      message: present ? "gift line must be auto-added" : "gift line must be removed",
      timeout: 30_000,
      intervals: [2_000],
    })
    .toBe(present);
  return getCart(page);
}

test.describe("Gift offer — auto-add", () => {
  test.beforeEach(async ({ page }) => openAnchorWithEmptyCart(page));

  test("auto-adds a fully discounted gift when the qualifying product is added", async ({ page }) => {
    await addLines(page, [{ id: anchorVariant, quantity: 1 }]);
    const cart = await waitForGift(page, true);

    const gifts = cart.items.filter(isGift);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]?.quantity, "default gift limit is one set").toBe(1);
    expect(gifts[0]?.properties["_promo_engine_offer_id"]).toBeTruthy();
    expect(gifts[0]?.original_line_price).toBeGreaterThan(0);
    expect(gifts[0]?.final_line_price, "gift must be fully discounted").toBe(0);
  });

  test("does not duplicate the gift when the qualifying quantity grows", async ({ page }) => {
    await addLines(page, [{ id: anchorVariant, quantity: 1 }]);
    await waitForGift(page, true);
    await addLines(page, [{ id: anchorVariant, quantity: 2 }]);
    await expect
      .poll(async () => (await getCart(page)).items.find((i) => i.variant_id === anchorVariant)?.quantity, {
        timeout: 15_000,
        intervals: [2_000],
      })
      .toBe(3);

    const gifts = (await getCart(page)).items.filter(isGift);
    expect(gifts.reduce((sum, gift) => sum + gift.quantity, 0)).toBe(1);
  });

  test("removes the gift when the qualifying product is removed", async ({ page }) => {
    await addLines(page, [{ id: anchorVariant, quantity: 1 }]);
    let cart = await waitForGift(page, true);

    const line = cart.items.findIndex((item) => item.variant_id === anchorVariant) + 1;
    expect(line, "qualifying product must be in the cart").toBeGreaterThan(0);
    await changeLine(page, line, 0);

    cart = await waitForGift(page, false);
    expect(cart.items.some(isGift)).toBe(false);
  });
});

test.describe("Gift slider", () => {
  test("opens for selectable gifts or auto-adds the single gift", async ({ page }) => {
    await openAnchorWithEmptyCart(page);
    await addLines(page, [{ id: anchorVariant, quantity: 1 }]);

    const slider = page.locator(".pe-slider-overlay");
    await expect
      .poll(
        async () =>
          (await slider.isVisible().catch(() => false)) || (await getCart(page)).items.some(isGift),
        { message: "a slider must render or a gift must be auto-added", timeout: 30_000, intervals: [2_000] },
      )
      .toBe(true);

    if (await slider.isVisible().catch(() => false)) {
      await page.locator(".pe-gift-card").first().click();
      const confirm = page.locator(".pe-btn-confirm");
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await waitForGift(page, true);
    }
  });
});

test.describe("Checkout validation", () => {
  test("checkout is reachable with the gift in the cart", async ({ page }) => {
    await openAnchorWithEmptyCart(page);
    await addLines(page, [{ id: anchorVariant, quantity: 1 }]);
    await waitForGift(page, true);

    await gotoStorefront(page, "/cart");
    await page.locator('[name="checkout"]:visible').first().click();

    await expect(page).toHaveURL(/checkout/);
    await expect(page.locator("text=Cart has been updated")).not.toBeVisible({ timeout: 3_000 });
  });
});
