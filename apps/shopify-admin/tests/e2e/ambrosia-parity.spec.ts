import { expect, test, type Page } from "@playwright/test";

const ANCHOR_HANDLE = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";
const ANCHOR_VARIANT = Number(process.env["E2E_AMBROSIA_ANCHOR_VARIANT_ID"] ?? "50539370446931");
const SELLING_PLAN = Number(process.env["E2E_AMBROSIA_SELLING_PLAN_ID"] ?? "6553370707");
const FROTHER_VARIANT = Number(process.env["E2E_AMBROSIA_FROTHER_VARIANT_ID"] ?? "50539424186451");
const OTG_VARIANT = Number(process.env["E2E_AMBROSIA_OTG_VARIANT_ID"] ?? "50539371167827");
const GIFT_CARD_VARIANT = Number(
  process.env["E2E_AMBROSIA_GIFT_CARD_VARIANT_ID"] ?? "50539372806227",
);
const SHIRT_VARIANT = Number(process.env["E2E_AMBROSIA_SHIRT_VARIANT_ID"] ?? "50539598282835");

type CartItem = {
  variant_id: number;
  quantity: number;
  original_line_price: number;
  final_line_price: number;
  properties: Record<string, string>;
};

type Cart = { item_count: number; items: CartItem[] };

type AddLine = {
  id: number;
  quantity: number;
  selling_plan?: number;
  properties?: Record<string, string>;
};

function landingProperties(source: string): Record<string, string> {
  return {
    __landing_source: source,
    _promo_engine_metadata: JSON.stringify({ __landing_source: source }),
  };
}

async function cartRequest<T>(page: Page, path: string, init?: RequestInit): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      if (!response.ok)
        throw new Error(`Cart API ${path} failed: ${response.status} ${await response.text()}`);
      return response.json() as Promise<T>;
    },
    { path, init },
  );
}

async function clearCart(page: Page): Promise<void> {
  await cartRequest(page, "/cart/clear.js", { method: "POST" });
}

async function getCart(page: Page): Promise<Cart> {
  return cartRequest<Cart>(page, "/cart.js");
}

async function addLines(page: Page, items: AddLine[]): Promise<Cart> {
  await cartRequest(page, "/cart/add.js", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ items }),
  });
  return getCart(page);
}

async function openStorefront(page: Page): Promise<void> {
  await page.goto(`/products/${encodeURIComponent(ANCHOR_HANDLE)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/password(?:\?|$)/);
  await page.waitForFunction(() => typeof window.PromoEngine !== "undefined");
  await clearCart(page);
}

function expectVariantsFree(cart: Cart, variants: number[]): void {
  for (const variant of variants) {
    const line = cart.items.find((item) => item.variant_id === variant);
    expect(line, `Variant ${variant} must be in the cart`).toBeDefined();
    expect(
      line?.original_line_price,
      `Variant ${variant} must have a non-zero list price`,
    ).toBeGreaterThan(0);
    expect(line?.final_line_price, `Variant ${variant} must be fully discounted`).toBe(0);
  }
}

function expectVariantsPaid(cart: Cart, variants: number[]): void {
  for (const variant of variants) {
    const line = cart.items.find((item) => item.variant_id === variant);
    expect(line, `Variant ${variant} must be in the cart`).toBeDefined();
    expect(line?.final_line_price, `Variant ${variant} must remain paid`).toBe(
      line?.original_line_price,
    );
  }
}

const subscriptionLandingRules = [
  { source: "nektar-glp1-sk", targets: [FROTHER_VARIANT] },
  { source: "nektar-skin-v2", targets: [FROTHER_VARIANT] },
  { source: "kinetic-sk-otg", targets: [GIFT_CARD_VARIANT, OTG_VARIANT] },
  { source: "atlas-sk-otg", targets: [GIFT_CARD_VARIANT, OTG_VARIANT, SHIRT_VARIANT] },
  { source: "nektar-sk-otg", targets: [OTG_VARIANT] },
  { source: "planta-sk-otg", targets: [OTG_VARIANT] },
  { source: "nektar-sk-special-offer", targets: [FROTHER_VARIANT] },
] as const;

test.describe("Ambrosia migration parity", () => {
  test.beforeEach(async ({ page }) => openStorefront(page));

  for (const rule of subscriptionLandingRules) {
    test(`${rule.source} grants the same subscription landing gifts`, async ({ page }) => {
      const properties = landingProperties(rule.source);
      const cart = await addLines(page, [
        { id: ANCHOR_VARIANT, quantity: 1, selling_plan: SELLING_PLAN, properties },
        ...rule.targets.map((id) => ({ id, quantity: 1, properties })),
      ]);
      expectVariantsFree(cart, [...rule.targets]);
    });
  }

  test("subscription landing rule fails closed without a selling plan", async ({ page }) => {
    const properties = landingProperties("nektar-glp1-sk");
    const cart = await addLines(page, [
      { id: ANCHOR_VARIANT, quantity: 1, properties },
      { id: FROTHER_VARIANT, quantity: 1, properties },
    ]);
    expectVariantsPaid(cart, [FROTHER_VARIANT]);
  });

  test("landing rule does not accept an unscoped target line", async ({ page }) => {
    const properties = landingProperties("nektar-glp1-sk");
    const cart = await addLines(page, [
      { id: ANCHOR_VARIANT, quantity: 1, selling_plan: SELLING_PLAN, properties },
      { id: FROTHER_VARIANT, quantity: 1 },
    ]);
    expectVariantsPaid(cart, [FROTHER_VARIANT]);
  });

  test("Planta + Atlas combo requires two scoped anchors and no subscription", async ({ page }) => {
    const properties = landingProperties("planta-atlas-combo-sk");
    let cart = await addLines(page, [
      { id: ANCHOR_VARIANT, quantity: 1, properties },
      { id: OTG_VARIANT, quantity: 1, properties },
      { id: GIFT_CARD_VARIANT, quantity: 1, properties },
    ]);
    expectVariantsPaid(cart, [OTG_VARIANT, GIFT_CARD_VARIANT]);

    await clearCart(page);
    cart = await addLines(page, [
      { id: ANCHOR_VARIANT, quantity: 2, properties },
      { id: OTG_VARIANT, quantity: 1, properties },
      { id: GIFT_CARD_VARIANT, quantity: 1, properties },
    ]);
    expectVariantsFree(cart, [OTG_VARIANT, GIFT_CARD_VARIANT]);
  });

  test("$85 subtotal exposes one selectable free shirt and applies it", async ({ page }) => {
    await addLines(page, [{ id: ANCHOR_VARIANT, quantity: 1 }]);

    const slider = page.locator(".pe-slider-overlay");
    await expect(slider).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".pe-gift-card")).toHaveCount(4);
    await page.locator(".pe-gift-card").first().click();
    await page.locator(".pe-btn-confirm").click();

    await expect
      .poll(
        async () => {
          const cart = await getCart(page);
          const gift = cart.items.find(
            (item) => item.properties["_promo_engine_line_type"] === "gift",
          );
          return gift?.final_line_price;
        },
        { timeout: 10_000 },
      )
      .toBe(0);

    const cart = await getCart(page);
    const gifts = cart.items.filter(
      (item) => item.properties["_promo_engine_line_type"] === "gift",
    );
    expect(gifts).toHaveLength(1);
    expect(gifts[0]?.quantity).toBe(1);
  });
});
