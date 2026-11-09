import { describe, expect, it } from "vitest";
import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import { evaluateSpecificProduct } from "./conditions/specific-product.js";
import { evaluatePack } from "./conditions/pack.js";
import { evaluateLineAttribute } from "./conditions/attributes.js";
import { consumeAnchors, freeUnits, giftAnchors } from "./gift-anchors.js";
import type { OfferDefinition } from "./evaluator.js";

const line = (key: string, variant: string, priceCents: number, quantity: number, properties: Record<string, string> = {}): NormalizedCartLine => ({
  key,
  variantId: variant,
  productId: `p-${variant}`,
  quantity,
  priceCents,
  compareAtPriceCents: null,
  properties,
  requiresSellingPlan: false,
  sellingPlanId: null,
  productHandle: key,
  productTitle: key,
  variantTitle: null,
  vendor: "v",
  productType: "t",
  tags: [],
  collections: [],
  availableForSale: true,
  inventoryPolicy: "DENY",
  inventoryQuantity: 10,
});
const cartOf = (...lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t",
  id: null,
  lines,
  subtotalCents: lines.reduce((s, l) => s + l.priceCents * l.quantity, 0),
  discountCodes: [],
  currencyCode: "USD",
  totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
});

const need2 = { requirements: [{ productId: "p-x", variantId: "x", trackMode: "variant" as const, minQuantity: 2 }], multiplyByGroups: false };

describe("specific_product with a $0 line from another app", () => {
  it("is not satisfied by a $0 unit", () => {
    expect(evaluateSpecificProduct(cartOf(line("a", "x", 1000, 1), line("b", "x", 0, 1)), need2).ok).toBe(false);
  });
  it("is satisfied by paid units plus a $0 line", () => {
    expect(evaluateSpecificProduct(cartOf(line("a", "x", 1000, 2), line("b", "x", 0, 1)), need2).ok).toBe(true);
  });
  it("does not let a $0 line exceed the maximum", () => {
    const capped = { requirements: [{ ...need2.requirements[0]!, minQuantity: 1, maxQuantity: 2 }], multiplyByGroups: false };
    expect(evaluateSpecificProduct(cartOf(line("a", "x", 1000, 2), line("b", "x", 0, 1)), capped).ok).toBe(true);
  });
  it("does not count a $0 line for the legacy variantIds format or an any-of trigger", () => {
    const zeroOnly = cartOf(line("b", "x", 0, 1));
    expect(evaluateSpecificProduct(zeroOnly, { variantIds: ["x"] } as never).ok).toBe(false);
    expect(evaluateSpecificProduct(zeroOnly, { ...need2, requirements: [{ ...need2.requirements[0]!, minQuantity: 1 }] }, "any").ok).toBe(false);
  });
  it("is unchanged for a cart without a $0 line", () => {
    expect(evaluateSpecificProduct(cartOf(line("a", "x", 1000, 1)), need2).ok).toBe(false);
    expect(evaluateSpecificProduct(cartOf(line("a", "x", 1000, 1), line("b", "x", 500, 1)), need2).ok).toBe(true);
  });
  it("prefers lineSubtotalCents over price x quantity when deciding a line is $0", () => {
    const discounted = { ...line("a", "x", 1000, 2), lineSubtotalCents: 0 };
    expect(evaluateSpecificProduct(cartOf(discounted), need2).ok).toBe(false);
  });
});

describe("pack_of_products with a $0 line from another app", () => {
  const pack = { requirements: [{ productId: "p-x", variantId: "x", trackMode: "variant" as const, quantityPerPack: 2 }], multiplyByGroups: false };
  it("does not complete a pack with a $0 unit", () => {
    expect(evaluatePack(cartOf(line("a", "x", 1000, 1), line("b", "x", 0, 1)), pack as never).ok).toBe(false);
    expect(evaluatePack(cartOf(line("a", "x", 1000, 2), line("b", "x", 0, 1)), pack as never).ok).toBe(true);
  });
});

describe("line_attribute with a $0 line from another app", () => {
  const cond = { key: "__bundle_type", value: "starter", matchMode: "equals" as const, minMatchingQuantity: 1 };
  const tagged = { __bundle_type: "starter" };
  it("is not satisfied by a $0 line", () => {
    expect(evaluateLineAttribute(cartOf(line("a", "x", 0, 1, tagged)), cond).ok).toBe(false);
  });
  it("is satisfied by a paid line next to a $0 line", () => {
    expect(evaluateLineAttribute(cartOf(line("a", "x", 1000, 1, tagged), line("b", "y", 0, 1, tagged)), cond).ok).toBe(true);
  });
  it("a $0 line does not block a not_equals condition", () => {
    expect(evaluateLineAttribute(cartOf(line("b", "y", 0, 1, tagged)), { ...cond, matchMode: "not_equals" }).ok).toBe(true);
    expect(evaluateLineAttribute(cartOf(line("a", "x", 1000, 1, tagged)), { ...cond, matchMode: "not_equals" }).ok).toBe(false);
  });
});

const baseOffer = (over: Partial<OfferDefinition>): OfferDefinition => ({
  id: "o",
  version: 1,
  type: "gift",
  priority: 1,
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [],
  rewards: [],
  combinationPolicy: {
    combinesWithOrderDiscounts: true,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true,
    stopLowerPriority: false,
    maxApplicationsPerCart: null,
    maxApplicationsPerCustomer: null,
  },
  giftValueCountsForOtherOffers: false,
  ...over,
});

describe("gift anchors with a $0 line from another app", () => {
  const landing = baseOffer({
    type: "discount",
    rewards: [
      {
        id: "r",
        rewardType: "product_discount",
        discountType: "free",
        value: { amount: 100 },
        target: { scopeMode: "landing", requiredLineAttributeValue: "lp", requiredAnchorVariantIds: ["x"], requiredAnchorMinQuantity: 2, productIds: ["p-t"] },
        sortOrder: 0,
      } as never,
    ],
  });
  const lp = { __landing_source: "lp" };
  it("a $0 landing anchor is neither counted nor consumable", () => {
    const anchors = giftAnchors(landing, cartOf(line("a", "x", 1000, 1, lp), line("b", "x", 0, 1, lp)), new Set())!;
    expect(anchors.lines).toEqual([{ key: "a", quantity: 1 }]);
    expect(freeUnits(anchors, new Map())).toBeLessThan(anchors.needed);
    const consumed = new Map<string, number>();
    consumeAnchors(anchors, consumed);
    expect(consumed.has("b")).toBe(false);
  });
  it("paid anchors plus a $0 line keep the paid anchors only", () => {
    const anchors = giftAnchors(landing, cartOf(line("a", "x", 1000, 2, lp), line("b", "x", 0, 1, lp)), new Set())!;
    expect(anchors.lines).toEqual([{ key: "a", quantity: 2 }]);
  });

  const productGift = baseOffer({
    conditions: [
      { id: "c", scope: "main", conditionType: "specific_product", operator: "gte", value: need2, isEnabled: true, sortOrder: 0 },
    ],
    rewards: [{ id: "g", rewardType: "product_gift", discountType: "free", value: { percentage: 100 }, target: {}, sortOrder: 0 } as never],
  });
  it("a $0 line is not a product-gift anchor", () => {
    const anchors = giftAnchors(productGift, cartOf(line("a", "x", 1000, 1), line("b", "x", 0, 1)), new Set())!;
    expect(anchors.lines).toEqual([{ key: "a", quantity: 1 }]);
  });
  it("is unchanged for a cart without a $0 line", () => {
    const anchors = giftAnchors(productGift, cartOf(line("a", "x", 1000, 1), line("c", "x", 500, 1)), new Set())!;
    expect(anchors.lines).toEqual([{ key: "a", quantity: 1 }, { key: "c", quantity: 1 }]);
  });
});
