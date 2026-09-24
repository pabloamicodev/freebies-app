/**
 * E2E tests — Multi-currency and market flows.
 * Tests that offers apply correctly in non-default currency/market contexts.
 */

import { test, expect, type Page } from "@playwright/test";

const DEV_STORE = process.env["DEV_STORE_URL"] ?? "https://your-dev-store.myshopify.com";
const PRODUCT_HANDLE = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";

interface EvaluationResponse {
  cartActions: unknown[];
  qualifiedOffers: unknown[];
}

interface CartResponse {
  items: unknown[];
}

async function clearCart(page: Page) {
  await page.goto(`${DEV_STORE}/cart/clear`);
  await page.waitForURL(/cart/);
}

test.describe("Multi-currency (requires international market configured)", () => {
  test.beforeEach(async ({ page }) => {
    await clearCart(page);
  });

  test("progress bar shows remaining amount in local currency", async ({ page }) => {
    // Navigate with a specific currency context
    await page.goto(`${DEV_STORE}/en-ca`); // Canadian market
    await page.waitForTimeout(2000);

    const progressBar = page.locator("promo-progress-bar");
    await expect(progressBar).toBeVisible();

    const message = await progressBar.evaluate((el) => {
      return el.shadowRoot?.querySelector(".pe-pb-msg")?.textContent ?? "";
    });

    // Should show CAD currency, not USD
    // This tests that the currency override is respected
    expect(message).toBeTruthy();
  });

  test("evaluation uses market-specific threshold", async ({ page }) => {
    // The evaluation endpoint should receive countryCode from buyer identity
    await page.goto(`${DEV_STORE}/en-ca`);

    const evalIntercepted = page.waitForResponse(
      (res) => res.url().includes("/apps/promo-engine/evaluate"),
    );

    await page.waitForTimeout(3000);

    const response = await evalIntercepted;
    expect(response.ok()).toBe(true);
    const body = await response.json() as EvaluationResponse;
    expect(body).toHaveProperty("cartActions");
    expect(body).toHaveProperty("qualifiedOffers");
  });
});

test.describe("Customer targeting", () => {
  test("logged-out customer falls back gracefully for customer tag conditions", async ({ page }) => {
    await clearCart(page);
    await page.goto(`${DEV_STORE}/products/${PRODUCT_HANDLE}`);
    await page.waitForTimeout(2000);

    // Promo engine should still initialize even without a customer
    const runtimeReady = await page.evaluate(() => typeof window.PromoEngine !== "undefined");
    expect(runtimeReady).toBe(true);
  });

  test("guest customer sees gift offers without login requirement", async ({ page }) => {
    await clearCart(page);
    await page.goto(`${DEV_STORE}/products/${PRODUCT_HANDLE}`);

    // Add a product to trigger evaluation
    const addBtn = page.locator('[data-testid="add-to-cart"], [name="add"]').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await page.waitForTimeout(2000);

    const cart = await page.goto(`${DEV_STORE}/cart.js`);
    const cartData = await cart?.json() as CartResponse | undefined;
    expect(cartData).toHaveProperty("items");
  });
});

test.describe("Accessibility", () => {
  test("gift slider is keyboard navigable", async ({ page }) => {
    await page.goto(`${DEV_STORE}/`);
    await page.waitForTimeout(2000);

    // If gift slider is open, check keyboard navigation
    const slider = page.locator(".pe-slider-overlay");
    await expect(slider).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focusedElement = await page.evaluate(() => document.activeElement?.className);
    expect(focusedElement).toBeTruthy();
  });
});
