import { expect, test, type Page } from "@playwright/test";

const product = {
  id: "gid://shopify/Product/101",
  title: "Discount picker test product",
  handle: "discount-picker-test-product",
  vendor: "Test vendor",
  status: "ACTIVE",
  imageUrl: null,
  variants: [{
    id: "gid://shopify/ProductVariant/201",
    title: "Default Title",
    price: "20.00",
    availableForSale: true,
    requiresSellingPlan: false,
  }],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/products/search?*", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    await route.fulfill({ json: {
      products: !query || product.title.toLowerCase().includes(query.toLowerCase()) ? [product] : [],
      cache: { lastSyncedAt: "2026-10-02T12:00:00.000Z" },
    } });
  });
  await page.route("**/api/products/search/collections?*", async (route) => {
    await route.fulfill({ json: { collections: [{
      id: "gid://shopify/Collection/301",
      title: "Discount picker test collection",
    }] } });
  });

  await page.goto("/app/offers/new/codes/single");
  await page.getByRole("radio", { name: /Specific products/ }).check();
});

async function expectNavigationIdle(page: Page) {
  // The app only shows its navigation indicator after 300 ms. Give a stuck
  // document-navigation flag time to reveal itself before asserting absence.
  await page.waitForTimeout(400);
  await expect(page.locator(".b-route-loader")).toHaveCount(0);
}

test("code discounts can select, reopen, cancel and remove products", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const openPicker = page.getByRole("button", { name: "Select products", exact: true });
  const dialog = page.getByRole("dialog", { name: "Select products", exact: true });
  await openPicker.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search products" }).fill("missing product");
  await expect(dialog.getByText("No products found")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search products" }).fill("Discount picker");
  await dialog.getByRole("checkbox", { name: `Select ${product.title}`, exact: true }).check();
  await dialog.getByRole("button", { name: "Select (1)", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Remove ${product.title}`, exact: true })).toBeVisible();
  await expect(page.locator('input[name="productIds"]')).toHaveValue(JSON.stringify([product.id]));
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);

  await openPicker.click();
  const selected = dialog.getByRole("checkbox", { name: `Select ${product.title}`, exact: true });
  await expect(selected).toBeChecked();
  await selected.uncheck();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator('input[name="productIds"]')).toHaveValue(JSON.stringify([product.id]));
  await expect(openPicker).toBeFocused();

  await openPicker.click();
  await expect(selected).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Discount picker test collection", exact: true }).check();
  await expect(page.locator('input[name="collectionIds"]')).toHaveValue('["gid://shopify/Collection/301"]');
  await page.getByRole("button", { name: `Remove ${product.title}`, exact: true }).click();
  await expect(page.locator('input[name="productIds"]')).toHaveValue("[]");
  await expect(page.getByRole("button", { name: `Remove ${product.title}`, exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("collection search Enter keeps editing without submitting the code offer", async ({ page }) => {
  await page.getByRole("searchbox", { name: "Search collections" }).fill("prote");
  await page.getByRole("searchbox", { name: "Search collections" }).press("Enter");
  await page.getByRole("checkbox", { name: "Discount picker test collection", exact: true }).check();
  await expectNavigationIdle(page);
  await expect(page.getByText("Enter the discount code customers will type.", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[name="collectionIds"]')).toHaveValue('["gid://shopify/Collection/301"]');
  await page.getByRole("button", { name: "Select products", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Select products", exact: true })).toBeVisible();
});

test("client validation leaves the wizard idle and allows editing after a blocked navigation", async ({ page }) => {
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Enter the discount code customers will type.", { exact: true })).toBeVisible();
  await expectNavigationIdle(page);
  await page.getByRole("button", { name: "All Offers", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Discard unsaved changes", exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expectNavigationIdle(page);
  await page.getByRole("checkbox", { name: "Discount picker test collection", exact: true }).check();
  await expect(page.locator('input[name="collectionIds"]')).toHaveValue('["gid://shopify/Collection/301"]');
});
