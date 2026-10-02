import { expect, test, type Page } from "@playwright/test";

import { readFileSync } from "node:fs";

import {
  addLines,
  clearCart,
  getCart,
  gotoStorefront,
  waitForPromoEngine,
  type Cart,
} from "./helpers/storefront.js";

interface AmbrosiaFixtureRule {
  key: string;
  source: string;
  anchorVariant: number | null;
  sellingPlan: number | null;
  anchorMinQuantity: number;
  requiresSubscription: boolean;
  targets: number[];
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ambrosia.json", import.meta.url), "utf8"),
) as { rules: AmbrosiaFixtureRule[] };

// Regenerate fixtures/ambrosia.json after re-running `pnpm seed:ambrosia-e2e`.
const ANCHOR_HANDLE = process.env["E2E_PRODUCT_HANDLE"] ?? "test-product";
const FALLBACK_ANCHOR = Number(process.env["E2E_AMBROSIA_ANCHOR_VARIANT_ID"] ?? "50539370446931");
const SELLING_PLAN = Number(process.env["E2E_AMBROSIA_SELLING_PLAN_ID"] ?? "6553370707");
const rules = fixture.rules.map((rule) => ({
  ...rule,
  anchorVariant: rule.anchorVariant ?? FALLBACK_ANCHOR,
  sellingPlan: rule.sellingPlan ?? SELLING_PLAN,
}));
const rule = (key: string) => rules.find((candidate) => candidate.key === key)!;

function landingProperties(source: string): Record<string, string> {
  return {
    __landing_source: source,
    _promo_engine_metadata: JSON.stringify({ __landing_source: source }),
  };
}

async function openStorefront(page: Page): Promise<void> {
  await gotoStorefront(page, `/products/${encodeURIComponent(ANCHOR_HANDLE)}`);
  await waitForPromoEngine(page);
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

const subscriptionLandingRules = rules.filter((candidate) => candidate.requiresSubscription);

test.describe("Ambrosia migration parity", () => {
  test.beforeEach(async ({ page }) => openStorefront(page));

  for (const rule of subscriptionLandingRules) {
    test(`${rule.source} grants the same subscription landing gifts`, async ({ page }) => {
      const properties = landingProperties(rule.source);
      const cart = await addLines(page, [
        { id: rule.anchorVariant, quantity: rule.anchorMinQuantity, selling_plan: rule.sellingPlan, properties },
        ...rule.targets.map((id) => ({ id, quantity: 1, properties })),
      ]);
      expectVariantsFree(cart, rule.targets);
    });
  }

  test("subscription landing rule fails closed without a selling plan", async ({ page }) => {
    const nektar = rule("nektar-glp1-shaker-gift");
    const properties = landingProperties(nektar.source);
    const cart = await addLines(page, [
      { id: nektar.anchorVariant, quantity: 1, properties },
      ...nektar.targets.map((id) => ({ id, quantity: 1, properties })),
    ]);
    expectVariantsPaid(cart, nektar.targets);
  });

  test("landing rule does not accept an unscoped target line", async ({ page }) => {
    const nektar = rule("nektar-glp1-shaker-gift");
    const properties = landingProperties(nektar.source);
    const cart = await addLines(page, [
      { id: nektar.anchorVariant, quantity: 1, selling_plan: nektar.sellingPlan, properties },
      ...nektar.targets.map((id) => ({ id, quantity: 1 })),
    ]);
    expectVariantsPaid(cart, nektar.targets);
  });

  test("Planta + Atlas combo requires two scoped anchors and no subscription", async ({ page }) => {
    const combo = rule("landing-scoped-product-mtvt54kq");
    const properties = landingProperties(combo.source);
    const targets = combo.targets.map((id) => ({ id, quantity: 1, properties }));
    let cart = await addLines(page, [{ id: combo.anchorVariant, quantity: 1, properties }, ...targets]);
    expectVariantsPaid(cart, combo.targets);

    await clearCart(page);
    cart = await addLines(page, [{ id: combo.anchorVariant, quantity: 2, properties }, ...targets]);
    expectVariantsFree(cart, combo.targets);
  });

  test("$85 subtotal exposes one selectable free gift and applies it", async ({ page }) => {
    await addLines(page, [{ id: FALLBACK_ANCHOR, quantity: 1 }]);

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
