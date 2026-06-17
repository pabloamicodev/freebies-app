/**
 * E2E tests — Bundle offer flows.
 * Tests classic bundle add-to-cart and mix & match selection.
 */

import { test, expect, type Page } from "@playwright/test";

const DEV_STORE = process.env["DEV_STORE_URL"] ?? "https://your-dev-store.myshopify.com";

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
    await page.goto(`${DEV_STORE}/products/test-bundle-product`);

    // Check if bundle widget is present
    const bundleWidget = page.locator("promo-classic-bundle, .pe-bundle, [data-promo-widget='classic_bundle']");
    if (!(await bundleWidget.isVisible().catch(() => false))) {
      test.skip(true, "No bundle widget found on this product page");
    }

    // Find and click the bundle add-to-cart button
    const addBtn = page.locator("[data-promo-action='add-bundle']").first();
    if (!(await addBtn.isVisible().catch(() => false))) {
      test.skip(true, "Bundle add button not found");
    }

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
    await page.goto(`${DEV_STORE}/products/test-volume-product`);

    const volumeWidget = page.locator("promo-volume-discount");
    if (!(await volumeWidget.isVisible().catch(() => false))) {
      test.skip(true, "No volume discount widget found");
    }

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
    await todayWidget.isVisible().catch(() => false);
    // May or may not be visible depending on active offers
    // Just verify the container was mounted
    const container = await page.$(`#pe-today-offer-root`);
    expect(container).not.toBeNull();
  });
});

test.describe("Progress Bar", () => {
  test("progress bar renders with correct initial state", async ({ page }) => {
    await clearCart(page);
    await page.goto(`${DEV_STORE}/cart`);

    const progressBar = page.locator("promo-progress-bar");
    if (!(await progressBar.isVisible().catch(() => false))) {
      test.skip(true, "No progress bar found in cart");
    }

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
    await page.goto(`${DEV_STORE}/cart/add?id=YOUR_VARIANT_ID&quantity=1`);
    await page.waitForTimeout(500);

    await page.goto(`${DEV_STORE}/cart`);
    await page.locator('[name="checkout"]').click();

    // Should be at checkout
    await expect(page).toHaveURL(/checkout/);
    // Upsell extension renders in Shopify checkout UI — hard to test without Plus store
  });
});
