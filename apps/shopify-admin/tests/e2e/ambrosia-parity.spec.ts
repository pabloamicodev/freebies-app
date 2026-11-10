import { expect, test, type Page } from "@playwright/test";

import { readFileSync } from "node:fs";

import { E2E_SUBTOTAL_GIFT_HANDLE } from "./fixtures/live-offers.js";
import {
  addLines,
  clearCart,
  discountTitles,
  getCart,
  gotoStorefront,
  waitForPromoEngine,
  type Cart,
} from "./helpers/storefront.js";
import { allGiftSliders, dismissOpenGiftSliders, evaluateNow, requestGiftSlider } from "./helpers/widgets.js";

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
) as { rules: AmbrosiaFixtureRule[]; fixtureTitles: string[] };

// hpn-test-store also holds merchant-like QA offers (sitewide %, gift tiers) that discount the same catalog, so
// "paid" and "free" are judged only on discounts labelled with a fixture offer's title, never on the final price alone.
const FIXTURE_TITLES = new Set(fixture.fixtureTitles);
const fixtureDiscounts = (line: Parameters<typeof discountTitles>[0]) =>
  discountTitles(line).filter((title) => FIXTURE_TITLES.has(title));

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
    expect(
      fixtureDiscounts(line),
      `Variant ${variant} must be discounted by a fixture offer (saw: ${discountTitles(line).join(" | ")})`,
    ).not.toHaveLength(0);
  }
}

function expectVariantsPaid(cart: Cart, variants: number[]): void {
  for (const variant of variants) {
    const line = cart.items.find((item) => item.variant_id === variant);
    expect(line, `Variant ${variant} must be in the cart`).toBeDefined();
    expect(fixtureDiscounts(line), `Variant ${variant} must remain paid by the fixture offers`).toEqual([]);
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

    // QA gift offers can open their own pickers first; this test owns the picker whose gifts are the fixture stand-in.
    const evaluation = await evaluateNow(page);
    const fixtureSlider = allGiftSliders(evaluation).find(
      (slider) =>
        slider.selectableGifts.length > 0 &&
        slider.selectableGifts.every((gift) => gift.productHandle === E2E_SUBTOTAL_GIFT_HANDLE),
    );
    expect(fixtureSlider, "the $85 subtotal fixture must produce a gift picker").toBeDefined();
    const offerId = fixtureSlider!.offerId;

    await dismissOpenGiftSliders(page);
    await requestGiftSlider(page, offerId);
    const slider = page.locator("dialog.pe-slider-overlay[open]");
    await expect(slider).toBeVisible({ timeout: 10_000 });
    await expect(slider.locator(".pe-gift-card")).toHaveCount(4);
    await slider.locator(".pe-gift-card").first().click();
    await slider.locator(".pe-btn-confirm").click();

    const ownGifts = async () =>
      (await getCart(page)).items.filter(
        (item) =>
          item.properties["_promo_engine_line_type"] === "gift" &&
          item.properties["_promo_engine_offer_id"] === offerId,
      );
    await expect.poll(async () => (await ownGifts())[0]?.final_line_price, { timeout: 10_000 }).toBe(0);

    const gifts = await ownGifts();
    expect(gifts).toHaveLength(1);
    expect(gifts[0]?.quantity).toBe(1);
  });
});
