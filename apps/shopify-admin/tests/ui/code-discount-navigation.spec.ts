import { expect, test } from "@playwright/test";

test("a same-page submit preserves embedded parameters and dirty fields after server validation", async ({ page }) => {
  const query = "?shop=hpn-test-store.myshopify.com&host=embedded-test";
  await page.goto(`/app/offers/new/codes/single${query}`);
  await page.getByRole("textbox", { name: "Discount code", exact: true }).fill("LOCALTEST");
  await page.getByRole("textbox", { name: "Offer name", exact: true }).fill("Local navigation test");
  await page.getByRole("textbox", { name: "Title customers see", exact: true }).fill("Local discount test");
  await expect(page.locator("form")).toHaveAttribute("action", `/app/offers/new/codes/single${query}`);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Test validation error", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Discard unsaved changes" })).toHaveCount(0);
  await expect(page.locator(".b-route-loader")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Discount code", exact: true })).toHaveValue("LOCALTEST");

  await page.getByRole("button", { name: "All Offers", exact: true }).click();
  await page.getByRole("dialog", { name: "Discard unsaved changes" })
    .getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(page.locator(".b-route-loader")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Discount code", exact: true })).toHaveValue("LOCALTEST");
});

test("a prevented native link leaves the app shell idle", async ({ page }) => {
  await page.goto("/app/offers/new/codes/single");
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "/app/offers";
    anchor.textContent = "Canceled native link";
    anchor.addEventListener("click", (event) => event.preventDefault());
    document.querySelector(".b-page")!.append(anchor);
  });
  await page.getByRole("link", { name: "Canceled native link", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(page.locator(".b-route-loader")).toHaveCount(0);
});
