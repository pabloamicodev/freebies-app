/**
 * Gift tiers: one gift offer whose gift rewards unlock at different cart subtotals. Cumulative gives every reached
 * tier, "highest" only the top one. Offers without tiers behave exactly as before.
 */
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator.js";
import { giftTierState } from "./gift-tiers.js";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import type { OfferDefinition, RewardDefinition } from "./evaluator.js";

const V = (n: string) => `gid://shopify/ProductVariant/${n}`;
const NOW = new Date("2026-06-01T12:00:00Z");

const line = (key: string, variantId: string, priceCents: number, properties: Record<string, string> = {}, productId = `gid://shopify/Product/${key}`): NormalizedCartLine => ({
  key, variantId, productId, quantity: 1, priceCents, compareAtPriceCents: null, properties,
  requiresSellingPlan: false, sellingPlanId: null, productHandle: key, productTitle: key, variantTitle: null, vendor: "v", productType: "t",
  tags: [], collections: [], availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
});
const gift = (rewardId: string) => ({
  _promo_engine_line_type: "gift",
  _promo_engine_offer_id: "offer-1",
  _promo_engine_reward_id: rewardId,
  _promo_engine_offer_version: "1",
});
const cartOf = (...lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t", id: null, lines, subtotalCents: lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0), discountCodes: [], currencyCode: "USD", totalQuantity: lines.length,
});
const inputOf = (cart: NormalizedCart, extra: Partial<EvaluationInput> = {}): EvaluationInput => ({
  shopDomain: "s.myshopify.com", cart, customer: null, market: null, locale: "en", salesChannel: "online_store", requestedUrl: null, sessionId: "s", ...extra,
});
const reward = (id: string, variantIds: string[], sortOrder: number, minCartSubtotalCents?: number): RewardDefinition => {
  const single = variantIds.length === 1;
  return {
    id, rewardType: "product_gift", discountType: "free", value: { percentage: 100 }, target: { scope: "cart", variantIds }, quantity: 1,
    isAutoAdd: single, isCustomerSelectable: !single, trackMode: single ? "variant" : "product", sortOrder, label: null,
    ...(minCartSubtotalCents ? { minCartSubtotalCents } : {}),
  };
};
const offerWith = (rewards: RewardDefinition[], tierMode?: "cumulative" | "highest", conditionThreshold = 7000): OfferDefinition => ({
  id: "offer-1", version: 1, type: "gift", priority: 100, ...(tierMode ? { tierMode } : {}), stopLowerPriority: false, startsAt: null, endsAt: null,
  conditions: [{ id: "c", scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: conditionThreshold, currencyCode: "USD", includeGiftValues: false }, isEnabled: true, sortOrder: 0 }],
  rewards,
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
});

const KIT = V("50");
const GREENS = V("51");
const tiers = (mode?: "cumulative" | "highest") => offerWith([reward("r-kit", [KIT], 0, 7000), reward("r-greens", [GREENS], 1, 11000)], mode);
const run = (offer: OfferDefinition, cart: NormalizedCart, extra: Partial<EvaluationInput> = {}) => evaluate(inputOf(cart, extra), { offers: [offer], usageStates: [], now: NOW });
const addedVariants = (r: Awaited<ReturnType<typeof run>>) => r.cartActions.flatMap((a) => (a.action === "add_line" ? [(a as { variantId: string }).variantId] : []));
const removed = (r: Awaited<ReturnType<typeof run>>) => r.cartActions.flatMap((a) => (a.action === "remove_line" ? [`${(a as { lineKey: string }).lineKey}:${(a as { reason?: string }).reason}`] : []));

describe("cumulative gift tiers", () => {
  it("adds only the gifts whose threshold the cart reached", async () => {
    expect(addedVariants(await run(tiers(), cartOf(line("a", V("1"), 8000))))).toEqual([KIT]);
    expect(addedVariants(await run(tiers(), cartOf(line("a", V("1"), 12000))))).toEqual([KIT, GREENS]);
    expect(addedVariants(await run(tiers("cumulative"), cartOf(line("a", V("1"), 12000))))).toEqual([KIT, GREENS]);
  });

  it("a gift whose tier is not met any more is removed with its own reason, the reached one stays", async () => {
    const cart = cartOf(line("a", V("1"), 8000), line("gk", KIT, 3000, gift("r-kit")), line("gg", GREENS, 3000, gift("r-greens")));
    const result = await run(tiers(), cart);
    expect(removed(result)).toEqual(["gg:gift_tier_not_met"]);
    expect(addedVariants(result)).toEqual([]);
  });

  it("gift lines never count toward the tier, so adding the gifts cannot unlock the next one", async () => {
    const cart = cartOf(line("a", V("1"), 9000), line("gk", KIT, 5000, gift("r-kit")));
    const result = await run(tiers(), cart);
    expect(addedVariants(result)).toEqual([]);
    expect(giftTierState(tiers(), cart, { activeCurrencyCode: "USD", shopCurrencyCode: "USD" }, new Set())?.currentCents).toBe(9000);
  });

  it("excluded products do not count", async () => {
    const offer = tiers();
    offer.conditions.push({ id: "x", scope: "sub", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 0, currencyCode: "USD", includeGiftValues: false, scopeFilter: { excludeProductIds: ["gid://shopify/Product/skip"] } }, isEnabled: true, sortOrder: 1 });
    const cart = cartOf(line("a", V("1"), 8000), line("skip", V("2"), 5000, {}, "gid://shopify/Product/skip"));
    const state = giftTierState(offer, cart, { activeCurrencyCode: "USD", shopCurrencyCode: "USD" }, new Set(["gid://shopify/Product/skip"]));
    expect(state?.currentCents).toBe(8000);
    expect([...state!.unmetRewardIds]).toEqual(["r-greens"]);
  });

  it("a declined tier gift is not re-added while the other tiers still are", async () => {
    const result = await run(tiers(), cartOf(line("a", V("1"), 12000)), { declinedGiftRewards: ["offer-1:r-greens"] });
    expect(addedVariants(result)).toEqual([KIT]);
  });
});

describe("highest-tier-only gift tiers", () => {
  it("adds only the top reached tier's gift and removes the lower tier's", async () => {
    expect(addedVariants(await run(tiers("highest"), cartOf(line("a", V("1"), 12000))))).toEqual([GREENS]);
    const cart = cartOf(line("a", V("1"), 12000), line("gk", KIT, 3000, gift("r-kit")));
    const result = await run(tiers("highest"), cart);
    expect(removed(result)).toEqual(["gk:gift_tier_not_met"]);
    expect(addedVariants(result)).toEqual([GREENS]);
  });

  it("gives the lower tier's gift while the top tier is not reached", async () => {
    expect(addedVariants(await run(tiers("highest"), cartOf(line("a", V("1"), 8000))))).toEqual([KIT]);
  });
});

describe("progress and picker", () => {
  it("one progress bar per offer points at the next tier, then reports every gift unlocked", async () => {
    const low = await run(tiers(), cartOf(line("a", V("1"), 8000)));
    expect(low.progressBars).toHaveLength(1);
    expect(low.progressBars[0]).toMatchObject({ offerId: "offer-1", currentCents: 8000, targetCents: 11000, isGoalReached: false });
    expect(low.progressBars[0]!.messageBeforeGoal).toContain("30.00");
    const high = await run(tiers(), cartOf(line("a", V("1"), 12000)));
    expect(high.progressBars[0]).toMatchObject({ currentCents: 12000, isGoalReached: true });
  });

  it("the picker lists only the reached tiers' gifts", async () => {
    const offer = offerWith([reward("r-kit", [KIT], 0, 7000), reward("r-pick", [V("60"), V("61")], 1, 11000)]);
    expect((await run(offer, cartOf(line("a", V("1"), 8000)))).giftSlider).toBeNull();
    const reached = await run(offer, cartOf(line("a", V("1"), 12000)));
    expect(reached.giftSlider?.selectableGifts.map((g) => g.variantId)).toEqual([V("60"), V("61")]);
  });
});

describe("offers without tiers are unchanged", () => {
  it("no tier fields: no tier state, same actions and the plain cart-value bar", async () => {
    const plain = offerWith([reward("r-kit", [KIT], 0), reward("r-greens", [GREENS], 1)]);
    expect(giftTierState(plain, cartOf(line("a", V("1"), 8000)), { activeCurrencyCode: "USD", shopCurrencyCode: "USD" }, new Set())).toBeNull();
    const result = await run(plain, cartOf(line("a", V("1"), 8000)));
    expect(addedVariants(result)).toEqual([KIT, GREENS]);
    expect(removed(result)).toEqual([]);
    expect(result.progressBars.every((bar) => !bar.messageBeforeGoal.includes("next gift"))).toBe(true);
  });

  it("tierMode alone, without a tiered reward, changes nothing", async () => {
    const plain = offerWith([reward("r-kit", [KIT], 0), reward("r-greens", [GREENS], 1)], "highest");
    expect(addedVariants(await run(plain, cartOf(line("a", V("1"), 8000))))).toEqual([KIT, GREENS]);
  });
});
