import { test } from "@playwright/test";
import { firstVariantId } from "./helpers/fixtures.js";
import { addLines, clearCart, getCart, gotoStorefront, waitForPromoEngine } from "./helpers/storefront.js";

const A = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";
const B = "test-volume-product";

const report = (label: string, cart: unknown) => console.log(`ORD2PROD ${label} ${JSON.stringify(cart)}`);

test("ORD2PROD probe: one line qty 2", async ({ page }) => {
  await gotoStorefront(page, `/products/${A}`);
  await waitForPromoEngine(page);
  const variant = await firstVariantId(page, A);
  await clearCart(page);
  await addLines(page, [{ id: variant, quantity: 2 }]);
  await page.waitForTimeout(6000);
  report("single", await getCart(page));
});

test("ORD2PROD probe: two lines qty 1+1", async ({ page }) => {
  await gotoStorefront(page, `/products/${A}`);
  await waitForPromoEngine(page);
  const a = await firstVariantId(page, A);
  const b = await firstVariantId(page, B);
  await clearCart(page);
  await addLines(page, [{ id: a, quantity: 1 }]);
  await gotoStorefront(page, `/products/${B}`);
  await waitForPromoEngine(page);
  await addLines(page, [{ id: b, quantity: 1 }]);
  await page.waitForTimeout(6000);
  report("double", await getCart(page));
});
