import { expect, test } from "@playwright/test";

test("the create-offer catalogue lists every offer family in one modal", async ({ page }) => {
  await page.goto("/app/offers/new");
  const catalogue = page.getByRole("dialog", { name: "Create a new offer" });
  await expect(catalogue).toBeVisible();
  for (const name of ["Gift offer", "Bundle offer", "Upsell offer", "Discount offer"]) {
    await expect(catalogue.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }
});

test("picking Gift offer then Create offer opens the scratch gift wizard", async ({ page }) => {
  await page.goto("/app/offers/new");
  await page.getByRole("dialog", { name: "Create a new offer" }).getByRole("button", { name: /Gift offer/ }).click();
  const gift = page.getByRole("dialog", { name: "Create gift offer" });
  await expect(gift).toBeVisible();
  await gift.getByRole("button", { name: "Create offer", exact: true }).click();
  // The harness uses a memory router, so assert on the routed content instead of the address bar.
  await expect(page.getByRole("heading", { name: "Wizard route" })).toBeVisible();
});

test("closing the catalogue returns to the offers list", async ({ page }) => {
  await page.goto("/app/offers/new");
  await page.getByRole("dialog", { name: "Create a new offer" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "All offers" })).toBeVisible();
});

test("?type=gift opens straight on the gift step and Back returns to the catalogue", async ({ page }) => {
  await page.goto("/app/offers/new?type=gift");
  const gift = page.getByRole("dialog", { name: "Create gift offer" });
  await expect(gift).toBeVisible();
  await gift.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create a new offer" })).toBeVisible();
});
