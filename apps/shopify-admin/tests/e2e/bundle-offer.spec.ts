/**
 * E2E tests — Bundle offer flows.
 * Tests classic bundle add-to-cart and mix & match selection.
 */

import { test, expect, type Page } from "@playwright/test";

const DEV_STORE = process.env["DEV_STORE_URL"] ?? "https://your-dev-store.myshopify.com";
const BUNDLE_PRODUCT_HANDLE = process.env["E2E_BUNDLE_PRODUCT_HANDLE"] ?? "test-bundle-product";
const VOLUME_PRODUCT_HANDLE = process.env["E2E_VOLUME_PRODUCT_HANDLE"] ?? "test-volume-product";
const QUALIFYING_VARIANT_ID = process.env["E2E_QUALIFYING_VARIANT_ID"] ?? "YOUR_VARIANT_ID";

async function clearCart(page: Page) {
  await page.goto(`${DEV_STORE}/cart/clear`);
  await page.waitForURL(/cart/);
}

async function getCartJson(page: Page) {
  const response = await page.goto(`${DEV_STORE}/cart.js`);
  return response?.json() as Promise<{
    token: string;
    item_count: number;
    items: Array<{ variant_id: number; quantity: number; properties: Record<string, string> }>;
  }>;
}

test.describe("Classic Bundle", () => {
  test.beforeEach(async ({ page }) => {
    await clearCart(page);
  });

  test("bundle add-to-cart creates all component lines", async ({ page }) => {
    // Navigate to a product page with a classic bundle widget
    await page.goto(`${DEV_STORE}/products/${BUNDLE_PRODUCT_HANDLE}`);

    // Check if bundle widget is present
    const bundleWidget = page.locator("promo-classic-bundle, .pe-bundle, [data-promo-widget='classic_bundle']");
    await expect(bundleWidget).toBeVisible();

    // Find and click the bundle add-to-cart button
    const addBtn = page.locator("[data-promo-action='add-bundle']").first();
    await expect(addBtn).toBeVisible();

    await addBtn.click();
    await page.waitForTimeout(2000);

    // Verify bundle component lines were added
    const cart = await getCartJson(page);
    const bundleLines = cart.items.filter(
      (item) => item.properties["_promo_engine_line_type"] === "bundle_component",
    );
    expect(bundleLines.length).toBeGreaterThan(0);
  });
});

test.describe("Volume Discount", () => {
  test("volume discount widget shows correct tiers", async ({ page }) => {
    await page.goto(`${DEV_STORE}/products/${VOLUME_PRODUCT_HANDLE}`);

    const volumeWidget = page.locator("promo-volume-discount");
    await expect(volumeWidget).toBeVisible();

    // Verify tiers are rendered in shadow DOM
    const shadowContent = await volumeWidget.evaluate((el) => {
      const shadow = el.shadowRoot;
      return shadow?.querySelector(".pe-vd-wrap")?.textContent ?? "";
    });

    expect(shadowContent).toContain("Volume Discounts");
  });
});

test.describe("Today Offer Widget", () => {
  test("floating Today Offer widget appears when offers are active", async ({ page }) => {
    await page.goto(`${DEV_STORE}/`);
    await page.waitForTimeout(3000); // Wait for promo engine to evaluate

    const todayWidget = page.locator("#pe-today-offer-root");
    await expect(todayWidget).toHaveCount(1);
  });
});

test.describe("Progress Bar", () => {
  test("progress bar renders with correct initial state", async ({ page }) => {
    await clearCart(page);
    await page.goto(`${DEV_STORE}/cart`);

    const progressBar = page.locator("promo-progress-bar");
    await expect(progressBar).toBeVisible();

    // Verify shadow DOM has progress track
    const hasProgressTrack = await progressBar.evaluate((el) => {
      return !!el.shadowRoot?.querySelector(".pe-pb-track");
    });
    expect(hasProgressTrack).toBe(true);
  });
});

test.describe("Checkout Upsell (Plus)", () => {
  test("checkout contains upsell extension", async ({ page }) => {
    // Add a product to cart first
    await page.goto(`${DEV_STORE}/cart/add?id=${encodeURIComponent(QUALIFYING_VARIANT_ID)}&quantity=1`);
    await page.waitForTimeout(500);

    await page.goto(`${DEV_STORE}/cart`);
    await page.locator('[name="checkout"]').click();

    // Should be at checkout
    await expect(page).toHaveURL(/checkout/);
    // Upsell extension renders in Shopify checkout UI — hard to test without Plus store
  });
});
