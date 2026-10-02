/**
 * E2E tests — bundle, volume and widget flows against hpn-test-store.
 *
 * Fixtures (scripts/seed-ambrosia-e2e.ts, fixed ids in fixtures/live-offers.ts):
 *   "E2E Classic Bundle"   — classic bundle of two ebooks, 10% off from two items
 *   "E2E Volume Discount"  — tiers at 2 and 5 units on the volume product
 * Widgets are mounted like the theme blocks would (helpers/widgets.ts).
 */

import { test, expect, type Page } from "@playwright/test";

import {
  E2E_BUNDLE_OFFER_ID,
  E2E_GIFT_ANCHOR_HANDLE,
  E2E_VOLUME_OFFER_ID,
  E2E_VOLUME_TIERS,
} from "./fixtures/live-offers.js";
import { firstVariantId } from "./helpers/fixtures.js";
import {
  addLines,
  clearCart,
  getCart,
  gotoStorefront,
  waitForPromoEngine,
} from "./helpers/storefront.js";
import { evaluateNow, mountBundleBuilder, mountWidget } from "./helpers/widgets.js";

const BUNDLE_PRODUCT_HANDLE = process.env["E2E_BUNDLE_PRODUCT_HANDLE"] ?? "test-bundle-product";
const VOLUME_PRODUCT_HANDLE = process.env["E2E_VOLUME_PRODUCT_HANDLE"] ?? "test-volume-product";
const QUALIFYING_VARIANT_ID = process.env["E2E_QUALIFYING_VARIANT_ID"] ?? "";

async function openProduct(page: Page, handle: string): Promise<void> {
  await gotoStorefront(page, `/products/${encodeURIComponent(handle)}`);
  await waitForPromoEngine(page);
  await clearCart(page);
}

test.describe("Classic bundle", () => {
  test("bundle add-to-cart creates component lines and applies the bundle discount", async ({ page }) => {
    await openProduct(page, BUNDLE_PRODUCT_HANDLE);
    await mountBundleBuilder(page, E2E_BUNDLE_OFFER_ID);

    const cards = page.locator(".pe-bb-product");
    await expect(cards).toHaveCount(2);
    await expect(page.locator(".pe-bb-tier")).toHaveCount(1);
    for (const index of [0, 1]) {
      await cards.nth(index).locator(".pe-bb-qty-ctrl button").last().click();
    }
    await expect(page.locator(".pe-bb-tier.pe-active")).toHaveCount(1);
    await page.locator(".pe-bb-btn-add").click();
    await expect(page.locator(".pe-bb-success")).toBeVisible();

    await expect
      .poll(
        async () =>
          (await getCart(page)).items.filter(
            (item) => item.properties?.["_promo_engine_line_type"] === "bundle_component",
          ).length,
        { message: "both bundle components must be in the cart", timeout: 20_000, intervals: [2_000] },
      )
      .toBe(2);

    const lines = (await getCart(page)).items.filter(
      (item) => item.properties?.["_promo_engine_line_type"] === "bundle_component",
    );
    for (const line of lines) {
      expect(line.properties["_promo_engine_offer_id"]).toBe(E2E_BUNDLE_OFFER_ID);
    }
    const listed = lines.reduce((sum, line) => sum + line.original_line_price, 0);
    const charged = lines.reduce((sum, line) => sum + line.final_line_price, 0);
    expect(charged, "the 10% bundle tier must discount the two components").toBeLessThan(listed);
  });
});

test.describe("Volume discount", () => {
  test("volume discount widget shows the configured tiers", async ({ page }) => {
    await openProduct(page, VOLUME_PRODUCT_HANDLE);
    const variant = await firstVariantId(page, VOLUME_PRODUCT_HANDLE);
    await mountWidget(page, "promo-volume-discount", {
      "offer-id": E2E_VOLUME_OFFER_ID,
      "variant-id": `gid://shopify/ProductVariant/${variant}`,
      currency: "USD",
    });

    const widget = page.locator("promo-volume-discount");
    await expect(widget.locator(".pe-vd-title")).toHaveText("Volume Discounts", { timeout: 15_000 });
    const tiers = widget.locator(".pe-vd-tier");
    await expect(tiers).toHaveCount(E2E_VOLUME_TIERS.length);
    await expect(tiers.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset["qty"]))).resolves.toEqual(
      E2E_VOLUME_TIERS.map((tier) => String(tier.minimumQuantity)),
    );
    await expect(widget.locator(".pe-vd-label").first()).toContainText(E2E_VOLUME_TIERS[0].label);
  });
});

test.describe("Today Offer block", () => {
  test("lists qualified offers once the cart qualifies", async ({ page }) => {
    await openProduct(page, E2E_GIFT_ANCHOR_HANDLE);
    await mountWidget(page, "promo-today-offer-block", { title: "Today's Offers" });
    const anchor = await firstVariantId(page, E2E_GIFT_ANCHOR_HANDLE);
    await addLines(page, [{ id: anchor, quantity: 1 }]);
    await evaluateNow(page);

    await expect(page.locator("promo-today-offer-block .pe-tob-item").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("promo-today-offer-block .pe-tob-header")).toContainText("Today's Offers");
  });
});

test.describe("Progress bar and cart message", () => {
  test("progress bar and cart message track the volume offer threshold", async ({ page }) => {
    await openProduct(page, VOLUME_PRODUCT_HANDLE);
    await mountWidget(page, "promo-progress-bar", { "offer-id": E2E_VOLUME_OFFER_ID, currency: "USD" });
    await mountWidget(page, "promo-cart-message", { "offer-id": E2E_VOLUME_OFFER_ID });

    const progress = page.locator("promo-progress-bar");
    await expect(progress.locator(".pe-pb-track")).toBeVisible();

    const variant = await firstVariantId(page, VOLUME_PRODUCT_HANDLE);
    await addLines(page, [{ id: variant, quantity: 1 }]);
    const evaluation = await evaluateNow(page);
    const bar = evaluation.progressBars.find((item) => item.offerId === E2E_VOLUME_OFFER_ID);
    expect(bar, "volume offer must report a progress bar").toBeDefined();
    expect(bar?.targetQuantity).toBe(E2E_VOLUME_TIERS[0].minimumQuantity);

    await expect(progress.locator(".pe-pb-msg")).toContainText("Add 1 more item", { timeout: 15_000 });
    await expect(progress.locator(".pe-pb-fill")).toHaveCSS("width", /^[1-9]/);
    await expect(page.locator("promo-cart-message .pe-msg")).toContainText("Add 1 more item", { timeout: 15_000 });

    await addLines(page, [{ id: variant, quantity: 1 }]);
    await evaluateNow(page);
    await expect(progress.locator(".pe-pb-msg")).toHaveText("Offer unlocked.", { timeout: 15_000 });
  });
});

test.describe("Checkout", () => {
  test("checkout opens for the qualifying variant", async ({ page }) => {
    expect(QUALIFYING_VARIANT_ID, "E2E_QUALIFYING_VARIANT_ID is required").toBeTruthy();
    await openProduct(page, VOLUME_PRODUCT_HANDLE);
    await addLines(page, [{ id: Number(QUALIFYING_VARIANT_ID), quantity: 1 }]);

    await gotoStorefront(page, "/cart");
    await page.locator('[name="checkout"]:visible').first().click();
    await expect(page).toHaveURL(/checkout/);
  });
});
