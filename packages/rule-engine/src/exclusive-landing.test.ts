/**
 * Exclusive landing tags (protein-edu-lp): a line carrying one only exists for the offers scoped to that tag (a landing
 * reward requiring it). Every other offer ignores it for thresholds, quantities, anchors, gifts and progress. Mirrors
 * discount_logic::tests::exclusive_landing and delivery_discount_logic (Rust).
 */
import { describe, expect, it } from "vitest";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import { evaluate, type ConditionDefinition, type OfferDefinition, type RewardDefinition } from "./evaluator.js";
import { landingScopesOf, landingSourceOf, visibleCart } from "./exclusive-landing.js";
import { referenceDiscounts, type ReferenceLine } from "./reference-discounts.js";

const EDU = "protein-edu-lp";
const NOW = new Date("2026-06-01T12:00:00Z");
const V = (n: string) => `gid://shopify/ProductVariant/${n}`;

const line = (key: string, priceCents: number, properties: Record<string, string> = {}, quantity = 1, variant = "1"): NormalizedCartLine => ({
  key, variantId: V(variant), productId: `gid://shopify/Product/${variant}`, quantity, priceCents, compareAtPriceCents: null, properties,
  requiresSellingPlan: false, sellingPlanId: null, productHandle: key, productTitle: key, variantTitle: null, vendor: "v", productType: "t",
  tags: [], collections: [], availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
});
const edu = (key: string, priceCents = 4999, quantity = 1) => line(key, priceCents, { __landing_source: EDU, _promo_page_url: "/pages/protein-for-sweet-cravings" }, quantity);
const packedEdu = (key: string) =>
  line(key, 4999, { _promo_engine_metadata: JSON.stringify({ __landing_source: EDU, _promo_page_url: "/pages/protein-for-sweet-cravings" }) });
const cartOf = (...lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t", id: null, lines, subtotalCents: lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0), discountCodes: [], currencyCode: "USD",
  totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
});
const inputOf = (cart: NormalizedCart): EvaluationInput => ({
  shopDomain: "s.myshopify.com", cart, customer: null, market: null, locale: "en", salesChannel: "online_store", requestedUrl: null, sessionId: "s",
});
const condition = (conditionType: string, value: unknown): ConditionDefinition => ({
  id: conditionType, scope: "main", conditionType, operator: "gte", value, isEnabled: true, sortOrder: 0,
});
const offer = (id: string, type: string, conditions: ConditionDefinition[], rewards: RewardDefinition[], priority = 100): OfferDefinition => ({
  id, version: 1, type, priority, stopLowerPriority: false, startsAt: null, endsAt: null, conditions, rewards,
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
});
const reward = (id: string, rewardType: string, target: Record<string, unknown>, extra: Partial<RewardDefinition> = {}): RewardDefinition => ({
  id, rewardType, discountType: "free", value: { percentage: 100 }, target, quantity: 1, isAutoAdd: false, isCustomerSelectable: false,
  trackMode: "variant", sortOrder: 0, label: null, ...extra,
});

const giftTier = offer("gift-tier", "gift", [condition("cart_value", { thresholdCents: 7000, currencyCode: "USD", includeGiftValues: false })], [
  reward("r-gift", "product_gift", { scope: "cart", variantIds: [V("50")] }, { isAutoAdd: true }),
]);
const bfOrder = offer("bf-order", "discount", [condition("cart_value", { thresholdCents: 9000, currencyCode: "USD", includeGiftValues: false })], [
  reward("order", "order_discount", { scope: "order" }, { discountType: "percentage", value: { percentage: 15 } }),
]);
const eduBundle = offer("edu", "discount", [], [
  reward("edu-price", "product_discount", { scopeMode: "landing", requiredLineAttributeValue: EDU, subscriptionMode: "subscription_only" }),
], 5);

const run = (offers: OfferDefinition[], cart: NormalizedCart) => evaluate(inputOf(cart), { offers, usageStates: [], now: NOW });
const qualified = async (offers: OfferDefinition[], cart: NormalizedCart) => (await run(offers, cart)).qualifiedOffers.map((o) => o.offerId).sort();
const added = async (offers: OfferDefinition[], cart: NormalizedCart) =>
  (await run(offers, cart)).cartActions.flatMap((a) => (a.action === "add_line" ? [(a as { variantId: string }).variantId] : []));

describe("exclusive landing lines", () => {
  it("reads the tag from the direct property or the packed metadata", () => {
    expect(landingSourceOf(edu("a").properties)).toBe(EDU);
    expect(landingSourceOf(packedEdu("a").properties)).toBe(EDU);
    expect(landingSourceOf({ _promo_engine_metadata: "{broken" })).toBeUndefined();
    expect(landingSourceOf({})).toBeUndefined();
  });

  it("hides them only from offers not scoped to the tag", () => {
    const cart = cartOf(edu("edu"), packedEdu("packed"), line("pdp", 4999));
    const hidden = visibleCart(cart, landingScopesOf(giftTier.rewards));
    expect(hidden.lines.map((l) => l.key)).toEqual(["pdp"]);
    expect(hidden.subtotalCents).toBe(4999);
    expect(hidden.totalQuantity).toBe(1);
    expect(visibleCart(cart, landingScopesOf(eduBundle.rewards))).toBe(cart);
    const otherTag = cartOf(line("lp", 4999, { __landing_source: "protein-complete-lp" }), line("pdp", 4999));
    expect(visibleCart(otherTag, new Set())).toBe(otherTag);
  });

  it("the edu value never lifts a mixed cart to a gift tier; other tags still count", async () => {
    expect(await added([giftTier], cartOf(line("pdp", 4000), edu("edu")))).toEqual([]);
    expect(await added([giftTier], cartOf(line("pdp", 4000), packedEdu("edu")))).toEqual([]);
    expect(await added([giftTier], cartOf(line("pdp", 4000), line("lp", 4999, { __landing_source: "protein-complete-lp" })))).toEqual([V("50")]);
    expect(await added([giftTier], cartOf(line("pdp", 4000), line("plain", 4999)))).toEqual([V("50")]);
  });

  it("an order offer's threshold only counts the lines outside the edu landing", async () => {
    expect(await qualified([bfOrder], cartOf(line("pdp", 4999), edu("edu")))).toEqual([]);
    expect(await qualified([bfOrder], cartOf(line("pdp", 4999), line("plain", 4999)))).toEqual(["bf-order"]);
  });

  it("edu-only carts keep the edu bundle and give the other offers nothing", async () => {
    const cart = cartOf(edu("edu", 4999, 3));
    expect(await qualified([giftTier, bfOrder, eduBundle], cart)).toEqual(["edu"]);
  });

  it("progress bars count only what the offer sees", async () => {
    const result = await run([giftTier], cartOf(line("pdp", 4000), edu("edu")));
    expect(result.progressBars.find((bar) => bar.offerId === "gift-tier")?.currentCents).toBe(4000);
  });

  it("the reference model leaves them out of other offers' rewards", () => {
    const ref = (id: string, metadata: Record<string, string> | null): ReferenceLine => ({
      id, variantId: V("1"), productId: "gid://shopify/Product/1", quantity: 1, unitPrice: "49.99", lineType: null, metadata,
    });
    const lines = [ref("edu", { __landing_source: EDU }), ref("pdp", null)];
    const tiers = [{ minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 15 }, { minimumQuantity: 2, discountType: "percentage", discountValue: 20 }];
    const sitewide = { id: "bf", productRewards: [{ id: "tiers", discountType: "percentage", discountValue: 0, quantityTiers: tiers }] };
    expect(referenceDiscounts(lines, { id: "bf", conditions: [] }, sitewide)).toEqual({ pdp: 1 });
    const scoped = { id: "edu", productRewards: [{ id: "edu", discountType: "free", scopeMode: "landing", requiredLineAttributeValue: EDU, requiredAnchorMinQuantity: 1 }] };
    expect(referenceDiscounts(lines, { id: "edu", conditions: [] }, scoped)).toEqual({ edu: 1 });
  });
});
