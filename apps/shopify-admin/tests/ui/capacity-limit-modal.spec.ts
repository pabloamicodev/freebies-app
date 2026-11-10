import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("a Shopify-limit failure opens an accessible modal that names the limit and the fix", async ({ page }) => {
  await page.goto("/app/offers/new/codes/single?shop=hpn-test-store.myshopify.com&host=embedded-test");
  await page.getByRole("textbox", { name: "Discount code", exact: true }).fill("LIMITTEST");
  await page.getByRole("textbox", { name: "Offer name", exact: true }).fill("Limit modal test");
  await page.getByRole("textbox", { name: "Discount message (shown in cart, checkout and orders)", exact: true }).fill("Limit modal");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Shopify's automatic discount limit is reached" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("25 active automatic discounts per store");
  await expect(dialog).toContainText("24 of 25 active (20 from other apps or Shopify)");
  await expect(dialog).toContainText("Spring gift");
  await expect(dialog.getByRole("link", { name: "Review automatic discounts" })).toHaveAttribute("href", /\/admin\/discounts$/);
  await expect(dialog.getByRole("button", { name: "Got it" })).toBeVisible();

  const results = await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
