import { expect, test } from "@playwright/test";

const WIZARD = "/app/offers/new/codes/single";

test("no dialog and a usable shell when the app has no open incidents", async ({ page }) => {
  await page.goto(WIZARD);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Discount code", exact: true }).fill("NOINCIDENT");
  await expect(page.getByRole("textbox", { name: "Discount code", exact: true })).toHaveValue("NOINCIDENT");
});

test("a layout loader that did not deliver the incident count degrades to no dialog, shell intact", async ({ page }) => {
  await page.goto(`${WIZARD}?incidents=missing`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Discount code", exact: true }).fill("MISSING");
  await expect(page.getByRole("textbox", { name: "Discount code", exact: true })).toHaveValue("MISSING");
});

test("opens once when an incident exists, loads the list, and Not now closes it so the page is usable again", async ({ page }) => {
  await page.goto(`${WIZARD}?incidents=1`);
  const dialog = page.getByRole("dialog", { name: "Offers blocked by a Shopify limit" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No blocked offers. Everything fits.")).toBeVisible();
  await dialog.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("textbox", { name: "Discount code", exact: true }).fill("AFTERCLOSE");
  await expect(page.getByRole("textbox", { name: "Discount code", exact: true })).toHaveValue("AFTERCLOSE");
});
