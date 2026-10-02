/**
 * E2E tests — market, currency and customer-context flows against hpn-test-store.
 *
 * hpn-test-store has an active Canada market (CAD). The "[Ambrosia E2E] cart-subtotal-free-gift"
 * fixture ($85 cart value) provides the cart-value progress bar, and the active
 * "E2E Gift Offer" fixture provides a gift for guests.
 */

import { test, expect, type Page } from "@playwright/test";

import { E2E_GIFT_ANCHOR_HANDLE } from "./fixtures/live-offers.js";
import { firstVariantId } from "./helpers/fixtures.js";
import {
  addLines,
  clearCart,
  getCart,
  gotoStorefront,
  waitForPromoEngine,
} from "./helpers/storefront.js";
import { evaluateNow, mountWidget } from "./helpers/widgets.js";

const PRODUCT_HANDLE = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";

async function openMarket(page: Page, path: string): Promise<void> {
  await gotoStorefront(page, path);
  await waitForPromoEngine(page);
  await clearCart(page);
}

test.describe("Multi-currency (Canada market)", () => {
  test("progress bar shows the remaining amount in CAD", async ({ page }) => {
    // The store has no /en-ca subfolder (that path is a 404); ?country=CA switches the localization cookie.
    await openMarket(page, "/?country=CA");
    await expect
      .poll(() => page.evaluate(() => (window as { Shopify?: { currency?: { active?: string } } }).Shopify?.currency?.active))
      .toBe("CAD");

    const anchor = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);
    await addLines(page, [{ id: anchor, quantity: 1 }]);
    const evaluation = await evaluateNow(page);
    const cartValueBar = evaluation.progressBars.find((bar) => bar.targetCents > 0 && !bar.isGoalReached);
    expect(cartValueBar, "a cart-value progress bar must be reported below the $85 threshold").toBeDefined();
    expect(cartValueBar?.messageBeforeGoal).toMatch(/CA\$/);

    await mountWidget(page, "promo-progress-bar", { "offer-id": cartValueBar!.offerId, currency: "CAD" });
    // The runtime skips evaluations for an unchanged cart, so change it to feed the new widget.
    await addLines(page, [{ id: anchor, quantity: 1 }]);
    await evaluateNow(page);
    await expect(page.locator("promo-progress-bar .pe-pb-msg")).toContainText("CA$", { timeout: 15_000 });
  });

  test("evaluation request carries the Canada market context", async ({ page }) => {
    await openMarket(page, "/?country=CA");
    const anchor = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);

    const evaluationRequest = page.waitForRequest((request) => request.url().includes("/apps/promo-engine/evaluate"), {
      timeout: 30_000,
    });
    await addLines(page, [{ id: anchor, quantity: 1 }]);
    const request = await evaluationRequest;

    const payload = request.postDataJSON() as { market?: { countryCode?: string; currencyCode?: string } };
    expect(payload.market?.countryCode).toBe("CA");
    expect(payload.market?.currencyCode).toBe("CAD");
    const response = await request.response();
    expect(response?.ok()).toBe(true);
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("cartActions");
    expect(body).toHaveProperty("qualifiedOffers");
  });
});

test.describe("Customer targeting", () => {
  test("logged-out customer still initialises the runtime", async ({ page }) => {
    await gotoStorefront(page, `/products/${encodeURIComponent(PRODUCT_HANDLE)}`);
    await waitForPromoEngine(page);
    expect(
      await page.evaluate(() => typeof (window as { PromoEngine?: { evaluate?: unknown } }).PromoEngine?.evaluate),
    ).toBe("function");
  });

  test("guest customer receives gift offers without logging in", async ({ page }) => {
    await gotoStorefront(page, `/products/${encodeURIComponent(E2E_GIFT_ANCHOR_HANDLE)}`);
    await waitForPromoEngine(page);
    await clearCart(page);
    const anchor = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);
    await addLines(page, [{ id: anchor, quantity: 1 }]);

    await expect
      .poll(
        async () =>
          (await getCart(page)).items.some((item) => item.properties?.["_promo_engine_line_type"] === "gift"),
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBe(true);
  });
});

test.describe("Accessibility", () => {
  test("gift slider is a keyboard-operable modal dialog", async ({ page }) => {
    await gotoStorefront(page, `/products/${encodeURIComponent(PRODUCT_HANDLE)}`);
    await waitForPromoEngine(page);
    await clearCart(page);
    const anchor = await firstVariantId(page, PRODUCT_HANDLE);
    await addLines(page, [{ id: anchor, quantity: 1 }]);

    const slider = page.locator("dialog.pe-slider-overlay");
    await expect(slider).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pe-slider-close")).toBeFocused();

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog.pe-slider-overlay"))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(slider).toBeHidden();
  });
});
