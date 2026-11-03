/**
 * "Automatically add all gifts" is stored one reward per gift product: a one-variant product is
 * auto-added, a multi-variant product opens the picker for that product only.
 */
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator.js";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import type { OfferDefinition, RewardDefinition } from "./evaluator.js";

const V = (n: string) => `gid://shopify/ProductVariant/${n}`;
const A = V("60");
const B = [V("70"), V("71"), V("72")];
const NOW = new Date("2026-06-01T12:00:00Z");

const line = (key: string, variantId: string, properties: Record<string, string> = {}): NormalizedCartLine => ({
  key,
  variantId,
  productId: `gid://shopify/Product/${key}`,
  quantity: 1,
  priceCents: 6000,
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
const gift = (rewardId: string) => ({
  _promo_engine_line_type: "gift",
  _promo_engine_offer_id: "offer-1",
  _promo_engine_reward_id: rewardId,
  _promo_engine_offer_version: "1",
});
const cartOf = (...lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t",
  id: null,
  lines,
  subtotalCents: 6000,
  discountCodes: [],
  currencyCode: "USD",
  totalQuantity: lines.length,
});
const inputOf = (cart: NormalizedCart): EvaluationInput => ({
  shopDomain: "s.myshopify.com",
  cart,
  customer: null,
  market: null,
  locale: "en",
  salesChannel: "online_store",
  requestedUrl: null,
  sessionId: "s",
});
const reward = (id: string, variantIds: string[], sortOrder: number): RewardDefinition => {
  const single = variantIds.length === 1;
  return {
    id,
    rewardType: "product_gift",
    discountType: "free",
    value: { percentage: 100 },
    target: { scope: "cart", variantIds },
    quantity: 1,
    isAutoAdd: single,
    isCustomerSelectable: !single,
    trackMode: single ? "variant" : "product",
    sortOrder,
    label: null,
  };
};
const offerWith = (rewards: RewardDefinition[]): OfferDefinition => ({
  id: "offer-1",
  version: 1,
  type: "gift",
  priority: 100,
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [
    {
      id: "c",
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false },
      isEnabled: true,
      sortOrder: 0,
    },
  ],
  rewards,
  combinationPolicy: {
    combinesWithOrderDiscounts: true,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true,
    stopLowerPriority: false,
    maxApplicationsPerCart: null,
    maxApplicationsPerCustomer: null,
  },
  giftValueCountsForOtherOffers: false,
});
const adds = (r: Awaited<ReturnType<typeof evaluate>>) => r.cartActions.filter((a) => a.action === "add_line");

describe("add-all gifts stored one reward per gift product", () => {
  it("regression: the legacy single reward with two variants adds nothing and caps at one", async () => {
    const legacy = { ...reward("r-legacy", [A, B[0]!], 0), isAutoAdd: true, isCustomerSelectable: false };
    const result = await evaluate(inputOf(cartOf(line("anchor", V("1")))), { offers: [offerWith([legacy])], usageStates: [], now: NOW });
    expect(adds(result)).toHaveLength(0);
    expect(result.giftSlider?.maxSelectableCount).toBe(1);
  });

  it("two single-variant auto-add rewards add both gifts and open no slider", async () => {
    const offer = offerWith([reward("r-a", [A], 0), reward("r-b", [V("80")], 1)]);
    const result = await evaluate(inputOf(cartOf(line("anchor", V("1")))), { offers: [offer], usageStates: [], now: NOW });
    expect(adds(result).map((a) => (a as { variantId: string }).variantId)).toEqual([A, V("80")]);
    expect(result.giftSlider).toBeNull();
  });

  it("a no-variant product auto-adds and the multi-variant product opens a picker with only its variants, max 1", async () => {
    const offer = offerWith([reward("r-a", [A], 0), reward("r-b", B, 1)]);
    const result = await evaluate(inputOf(cartOf(line("anchor", V("1")))), { offers: [offer], usageStates: [], now: NOW });
    expect(adds(result)).toMatchObject([{ variantId: A, quantity: 1 }]);
    expect(result.giftSlider?.selectableGifts.map((g) => g.variantId)).toEqual(B);
    expect(result.giftSlider?.maxSelectableCount).toBe(1);
    expect(result.giftSlider?.alreadySelectedCount).toBe(0);
  });

  it("after the shopper picks a size the picker is satisfied and gift A is not duplicated", async () => {
    const offer = offerWith([reward("r-a", [A], 0), reward("r-b", B, 1)]);
    const cart = cartOf(line("anchor", V("1")), line("ga", A, gift("r-a")), line("gb", B[1]!, gift("r-b")));
    const result = await evaluate(inputOf(cart), { offers: [offer], usageStates: [], now: NOW });
    expect(adds(result)).toHaveLength(0);
    expect(result.cartActions.filter((a) => a.action === "remove_line")).toHaveLength(0);
    expect(result.giftSlider?.alreadySelectedCount).toBe(result.giftSlider?.maxSelectableCount);
    expect(result.giftSlider?.selectableGifts.find((g) => g.variantId === B[1])?.isSelected).toBe(true);
  });

  it("re-qualifying with gift A already in the cart (under its own reward id) never adds it again", async () => {
    const offer = offerWith([reward("r-a", [A], 0), reward("r-c", [V("80")], 1)]);
    const cart = cartOf(line("anchor", V("1")), line("ga", A, gift("r-a")));
    const result = await evaluate(inputOf(cart), { offers: [offer], usageStates: [], now: NOW });
    expect(adds(result).map((a) => (a as { variantId: string }).variantId)).toEqual([V("80")]);
  });
});
