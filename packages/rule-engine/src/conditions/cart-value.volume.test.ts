import { describe, expect, it } from "vitest";
import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import { evaluateCartValue } from "./cart-value.js";
import { projectedVolumeDiscountCents } from "../cart-parser.js";

const currency = { activeCurrencyCode: "USD", shopCurrencyCode: "USD" };
const TIERS = [{ qty: 2, percent: 10 }, { qty: 3, percent: 20 }];

function line(
  key: string,
  over: Partial<NormalizedCartLine> & { priceCents: number; quantity: number },
): NormalizedCartLine {
  return {
    key,
    variantId: `gid://shopify/ProductVariant/${key}`,
    productId: "gid://shopify/Product/1",
    compareAtPriceCents: null,
    properties: {},
    requiresSellingPlan: false,
    sellingPlanId: null,
    productHandle: "p",
    productTitle: "P",
    variantTitle: null,
    vendor: "v",
    productType: "t",
    tags: [],
    collections: [],
    availableForSale: true,
    inventoryPolicy: "DENY",
    inventoryQuantity: 10,
    volumeDiscountTiers: TIERS,
    ...over,
  };
}

const cartOf = (lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t",
  id: null,
  lines,
  subtotalCents: lines.reduce((a, l) => a + l.priceCents * l.quantity, 0),
  discountCodes: [],
  currencyCode: "USD",
  totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
});
const cond = (thresholdCents: number) => ({ thresholdCents, currencyCode: "USD", includeGiftValues: false });

describe("cart_value nets out projected volume discounts (legacy / Function parity)", () => {
  it("picks the best tier per product over summed quantity and subtotal", () => {
    // 2 + 1 units of the same product across two lines -> 3 units -> 20% of 9000
    const lines = [line("a", { priceCents: 3000, quantity: 2 }), line("b", { priceCents: 3000, quantity: 1 })];
    expect(projectedVolumeDiscountCents(lines)).toBe(1800);
  });

  it("an $85 gift threshold is not met when volume discounts bring $90 below it", () => {
    const cart = cartOf([line("a", { priceCents: 4500, quantity: 2 })]); // 9000 - 10% = 8100
    expect(evaluateCartValue(cart, cond(8500), currency).ok).toBe(false);
    expect(evaluateCartValue(cart, cond(8100), currency).ok).toBe(true);
  });

  it("without tiers the raw subtotal is used", () => {
    const cart = cartOf([line("a", { priceCents: 4500, quantity: 2, volumeDiscountTiers: undefined })]);
    expect(evaluateCartValue(cart, cond(9000), currency).ok).toBe(true);
  });

  it.each([
    ["__cart_gift_tier", "tier-1"],
    ["_bundle_item", "true"],
    ["_nektar_glp1", "yes"],
  ])("skips %s lines when projecting the volume discount", (key, value) => {
    const l = line("a", { priceCents: 4500, quantity: 2, properties: { [key]: value } });
    expect(projectedVolumeDiscountCents([l])).toBe(0);
  });

  it("_bundle_item other than 'true' still counts", () => {
    const l = line("a", { priceCents: 4500, quantity: 2, properties: { _bundle_item: "false" } });
    expect(projectedVolumeDiscountCents([l])).toBe(900);
  });

  it("excludes gift lines from both the subtotal and the projection", () => {
    const cart = cartOf([
      line("a", { priceCents: 9000, quantity: 1, volumeDiscountTiers: undefined }),
      line("g", { priceCents: 5000, quantity: 2, properties: { __cart_gift_tier: "tier-1" } }),
    ]);
    expect(evaluateCartValue(cart, cond(9000), currency).ok).toBe(true);
    expect(evaluateCartValue(cart, cond(9001), currency).ok).toBe(false);
  });
});
