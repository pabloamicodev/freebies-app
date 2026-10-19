import { expect, test, type Page } from "@playwright/test";
import { installStorefront, reevaluate, STOREFRONT_URL } from "./storefront-fixture";

// The gift picker over a Dawn-like cart drawer and the persistent "free gift" prompt that stays after it closes, against the committed
// theme-extension bundle on a local fixture page (no store, no sign-in).

const CTA = "[data-promo-gift-cta]";
const CLOSE = "[data-promo-gift-close]";
const REMINDER = "[data-promo-gift-reminder]";

async function addToCart(page: Page) {
  await page.goto(STOREFRONT_URL);
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.locator("#atc").click();
  const dialog = page.getByRole("dialog", { name: "Choose your free gift" });
  await expect(dialog).toBeVisible();
  // Focus on the close button means the picker finished mounting: its Escape handling is attached from then on.
  await expect(dialog.locator(CLOSE)).toBeFocused();
  return dialog;
}

test.describe("gift picker over the theme cart drawer, and the prompt after it", () => {
  for (const [label, close] of [
    ["the close button", (page: Page) => page.locator(CLOSE).click()],
    ["Escape", (page: Page) => page.keyboard.press("Escape")],
    ["a click on the backdrop", (page: Page) => page.locator(".pe-slider-overlay").click({ position: { x: 4, y: 4 } })],
  ] as const) {
    test(`after add to cart the picker opens over the drawer; closing it with ${label} leaves the drawer usable and the prompt in it`, async ({ page }) => {
      const state = await installStorefront(page, { gift: true, drawer: true });
      const dialog = await addToCart(page);
      await expect(dialog.locator(CLOSE)).toHaveAccessibleName(/Close/);
      await close(page);
      await expect(dialog).toBeHidden();
      await expect(page.locator("cart-drawer").locator(CTA)).toBeVisible();

      await page.locator("#plus").click({ timeout: 2_000 });
      await expect(page.locator("#qty")).toHaveText("2");
      expect(state.cartChanges).toBeGreaterThan(0);
      await page.locator("#plus").click({ timeout: 2_000 });
      await reevaluate(page, state, {});
      await expect(dialog, "a cart change never reopens the picker by itself").toBeHidden();

      await page.locator(CTA).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /Canvas tote/ }).click();
      await dialog.getByRole("button", { name: /Add 1 Gift to Cart/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator(CTA)).toBeHidden();
      expect(state.cartAdds).toBe(1);
    });
  }

  test("the prompt is reachable and named, the picker returns focus to it, and it follows eligibility", async ({ page }) => {
    const state = await installStorefront(page, { gift: true, drawer: true });
    const dialog = await addToCart(page);
    await page.keyboard.press("Escape");
    const cta = page.locator(CTA);
    await expect(cta).toHaveAccessibleName("You unlocked a free gift. Choose it");
    await cta.press("Enter");
    await expect(dialog.locator(CLOSE)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(cta).toBeFocused();

    await cta.click();
    await dialog.getByRole("button", { name: /Enamel pin/ }).click();
    await dialog.getByRole("button", { name: /Add 1 Gift to Cart/ }).click();
    await expect(cta).toBeHidden();
    state.lines.splice(0, state.lines.length, ...state.lines.filter((line) => line["key"] === "paid:k"));
    await reevaluate(page, state, {});
    await expect(cta, "back when the gift line is removed").toBeVisible();
    await expect(dialog).toBeHidden();
    await reevaluate(page, state, { eligible: false });
    await expect(cta).toBeHidden();
  });

  test("the prompt survives the theme re-rendering the drawer", async ({ page }) => {
    await installStorefront(page, { gift: true, drawer: true });
    await addToCart(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(CTA)).toBeVisible();
    await page.locator("cart-drawer-items").evaluate((items) => {
      items.innerHTML = items.innerHTML;
    });
    await expect(page.locator("cart-drawer").locator(CTA)).toBeVisible();
    await expect(page.locator(CTA)).toHaveCount(1);
  });

  test("the cart page shows it after the picker was dismissed", async ({ page }) => {
    await installStorefront(page, { gift: true });
    await page.goto(new URL("cart", STOREFRONT_URL).href);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.locator(CLOSE).click();
    await expect(page.locator(`#cart + .pe-gift-prompt ${CTA}`)).toBeVisible();
  });
});

test.describe("checkout reminder", () => {
  async function dismissedDrawer(page: Page) {
    const state = await installStorefront(page, { gift: true, drawer: true });
    await page.goto(STOREFRONT_URL);
    await page.locator("#atc").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(CLOSE)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator(CTA)).toBeVisible();
    return state;
  }

  test("a gift picked at the reminder is in the cart when checkout opens", async ({ page }) => {
    const state = await dismissedDrawer(page);
    await page.locator("cart-drawer #co").click();
    const reminder = page.locator(REMINDER);
    await expect(reminder).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Don't forget your free gift" })).toBeVisible();
    await expect(reminder.locator("[data-promo-gift-reminder-continue]")).toHaveText("Continue to checkout without it");
    await reminder.getByRole("button", { name: /Canvas tote/ }).click();
    await reminder.getByRole("button", { name: /Add 1 Gift to Cart/ }).click();
    await page.waitForURL(/\/checkout$/);
    expect(state.checkedOut, "the gift was in the cart at checkout").toContain(101);
  });

  test("continuing without the gift goes to checkout", async ({ page }) => {
    const state = await dismissedDrawer(page);
    await page.locator("cart-drawer #co").click();
    await page.locator("[data-promo-gift-reminder-continue]").click();
    await page.waitForURL(/\/checkout$/);
    expect(state.checkedOut).toEqual([900]);
  });

  test("Escape closes the reminder and goes to checkout too", async ({ page }) => {
    const state = await dismissedDrawer(page);
    await page.locator("cart-drawer #co").click();
    await expect(page.locator(REMINDER)).toBeVisible();
    await expect(page.locator(REMINDER).locator(CLOSE)).toBeFocused();
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/checkout$/);
    expect(state.checkedOut).toEqual([900]);
  });
});
