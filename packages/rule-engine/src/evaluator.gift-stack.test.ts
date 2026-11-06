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
const variants = (r: Awaited<ReturnType<typeof evaluate>>) => adds(r).map((a) => (a as { variantId: string }).variantId).sort();
const at = (id: string, thresholdCents: number, rewardId: string, variant: string): OfferDefinition => {
  const o = offerWith([reward(rewardId, [variant], 0)]);
  return { ...o, id, conditions: [{ ...o.conditions[0]!, value: { thresholdCents, currencyCode: "USD", includeGiftValues: false } }] };
};
const cartAt = (units: number, ...extra: NormalizedCartLine[]) => {
  const anchor = { ...line("anchor", V("1")), priceCents: 2000, quantity: units };
  return { ...cartOf(anchor, ...extra), subtotalCents: 2000 * units, totalQuantity: units };
};
const kit = () => line("ga", A, { ...gift("r70"), _promo_engine_offer_id: "o70" });

describe("independent cart_value gift offers accumulate", () => {
  const offers = [at("o70", 7000, "r70", A), at("o110", 11000, "r110", V("80"))];
  const run = (cart: NormalizedCart) => evaluate(inputOf(cart), { offers, usageStates: [], now: NOW });

  it("adds both gifts at 112", async () => {
    expect(variants(await run(cartAt(6)))).toEqual([A, V("80")]);
  });

  it("keeps the first gift when the cart grows past the second threshold", async () => {
    const result = await run(cartAt(6, kit()));
    expect(result.cartActions.filter((a) => a.action === "remove_line")).toHaveLength(0);
    expect(variants(result)).toEqual([V("80")]);
  });
});

describe("with an unrelated selectable gift offer at 85", () => {
  const picker = { ...offerWith([reward("rp", B, 0)]), id: "op", priority: 102, conditions: [{ ...offerWith([]).conditions[0]!, value: { thresholdCents: 8500, currencyCode: "USD", includeGiftValues: false } }] };
  const offers = [{ ...at("o110", 11000, "r110", V("80")), priority: 1 }, { ...at("o70", 7000, "r70", A), priority: 1 }, picker];
  const run = (cart: NormalizedCart) => evaluate(inputOf(cart), { offers, usageStates: [], now: NOW });

  it("still adds both auto gifts", async () => {
    expect(variants(await run(cartAt(6)))).toEqual([A, V("80")]);
  });

  it("keeps both gifts once present", async () => {
    const both = [kit(), line("gg", V("80"), { ...gift("r110"), _promo_engine_offer_id: "o110" })];
    const result = await run(cartAt(6, ...both));
    expect(result.cartActions).toEqual([]);
  });
});
