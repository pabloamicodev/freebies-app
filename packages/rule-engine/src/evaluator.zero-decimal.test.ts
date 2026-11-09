/**
 * Zero-decimal shops store thresholds in whole units (the Functions read them that way) while the storefront cart is x100
 * subunits (assumption kept in `toCartUnits`). Two-decimal shops must compare exactly as before.
 * Keep the numbers in sync with the parity test in discount-function/src/discount_logic.rs.
 */
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator.js";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import type { OfferDefinition, RewardDefinition } from "./evaluator.js";

const NOW = new Date("2026-06-01T12:00:00Z");
const line = (priceCents: number): NormalizedCartLine => ({
  key: "a", variantId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1", quantity: 1, priceCents, compareAtPriceCents: null, properties: {},
  requiresSellingPlan: false, sellingPlanId: null, productHandle: "a", productTitle: "a", variantTitle: null, vendor: "v", productType: "t",
  tags: [], collections: [], availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
});
const cartOf = (priceCents: number, currencyCode: string): NormalizedCart => ({
  token: "t", id: null, lines: [line(priceCents)], subtotalCents: priceCents, discountCodes: [], currencyCode, totalQuantity: 1,
});
const inputOf = (cart: NormalizedCart, extra: Partial<EvaluationInput> = {}): EvaluationInput => ({
  shopDomain: "s.myshopify.com", cart, customer: null, market: null, locale: "en", salesChannel: "online_store", requestedUrl: null, sessionId: "s", ...extra,
});
const gift = (id: string, sortOrder: number, minCartSubtotalCents?: number): RewardDefinition => ({
  id, rewardType: "product_gift", discountType: "free", value: { percentage: 100 }, target: { scope: "cart", variantIds: [`gid://shopify/ProductVariant/${id}`] }, quantity: 1,
  isAutoAdd: true, isCustomerSelectable: false, trackMode: "variant", sortOrder, label: null, ...(minCartSubtotalCents ? { minCartSubtotalCents } : {}),
});
const offerOf = (condition: Record<string, unknown>, rewards: RewardDefinition[], tierMode?: "cumulative" | "highest", conditionType = "cart_value"): OfferDefinition => ({
  id: "offer-1", version: 1, type: "gift", priority: 100, ...(tierMode ? { tierMode } : {}), stopLowerPriority: false, startsAt: null, endsAt: null,
  conditions: [{ id: "c", scope: "main", conditionType, operator: "gte", value: { includeGiftValues: false, ...condition }, isEnabled: true, sortOrder: 0 } as never],
  rewards,
  combinationPolicy: { combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, stopLowerPriority: false, maxApplicationsPerCart: null, maxApplicationsPerCustomer: null },
  giftValueCountsForOtherOffers: false,
});
const run = (offer: OfferDefinition, cart: NormalizedCart, shopCurrencyCode: string, extra: Partial<EvaluationInput> = {}) =>
  evaluate(inputOf(cart, extra), { offers: [offer], usageStates: [], now: NOW, shopCurrencyCode });
const qualified = async (...args: Parameters<typeof run>) => (await run(...args)).qualifiedOffers.length === 1;
const granted = async (...args: Parameters<typeof run>) =>
  (await run(...args)).cartActions.flatMap((action) => (action.action === "add_line" ? [(action as { variantId: string }).variantId.split("/").pop()!] : []));

describe("cart_value on a JPY shop", () => {
  const offer = offerOf({ thresholdCents: 5000, currencyCode: "JPY" }, [gift("g", 0)]);
  it("a 5000 yen threshold needs a 5000 yen cart (x100 subunits), not 50 yen", async () => {
    expect(await qualified(offer, cartOf(500_000, "JPY"), "JPY")).toBe(true);
    expect(await qualified(offer, cartOf(499_900, "JPY"), "JPY")).toBe(false);
    expect(await qualified(offer, cartOf(5_000, "JPY"), "JPY")).toBe(false);
  });

  it("a condition without a currencyCode is read in the shop currency", async () => {
    const bare = offerOf({ thresholdCents: 5000 }, [gift("g", 0)]);
    expect(await qualified(bare, cartOf(5_000, "JPY"), "JPY")).toBe(false);
    expect(await qualified(bare, cartOf(500_000, "JPY"), "JPY")).toBe(true);
  });

  it("converts through the market rate and the minor-unit ratio, like config.rs localize", async () => {
    // 5000 yen at 0.0067 USD/JPY = 33.50 USD = 3350 cents.
    const market = { id: "gid://shopify/Market/1", handle: "us", currencyCode: "USD", countryCode: "US", primaryLocale: "en", exchangeRate: 0.0067 };
    expect(await qualified(offer, cartOf(3_400, "USD"), "JPY", { market })).toBe(true);
    expect(await qualified(offer, cartOf(3_300, "USD"), "JPY", { market })).toBe(false);
  });

  it("a per-currency override is in the active currency's own unit", async () => {
    const withOverride = offerOf({ thresholdCents: 5000, currencyCode: "JPY", currencyOverrides: { KRW: 50_000 } }, [gift("g", 0)]);
    const market = { id: "gid://shopify/Market/2", handle: "kr", currencyCode: "KRW", countryCode: "KR", primaryLocale: "ko", exchangeRate: 9 };
    expect(await qualified(withOverride, cartOf(5_000_000, "KRW"), "JPY", { market })).toBe(true);
    expect(await qualified(withOverride, cartOf(4_990_000, "KRW"), "JPY", { market })).toBe(false);
  });

  it("the progress bar target is the same threshold in cart units", async () => {
    const result = await run(offer, cartOf(200_000, "JPY"), "JPY");
    expect(result.progressBars[0]).toMatchObject({ targetCents: 500_000, currentCents: 200_000, isGoalReached: false });
    expect(result.progressBars[0]!.messageBeforeGoal).toContain("3,000");
  });
});

describe("gift tiers on a JPY shop", () => {
  const tiers = (mode?: "cumulative" | "highest") => offerOf({ thresholdCents: 5000, currencyCode: "JPY" }, [gift("51", 0, 5000), gift("52", 1, 12000)], mode);
  it("a 5000 yen tier is reached at a 5000 yen cart and not at 4999", async () => {
    expect(await granted(tiers(), cartOf(500_000, "JPY"), "JPY")).toEqual(["51"]);
    expect(await granted(tiers(), cartOf(499_900, "JPY"), "JPY")).toEqual([]);
  });
  it("cumulative and highest modes rank tiers in yen", async () => {
    expect((await granted(tiers("cumulative"), cartOf(1_300_000, "JPY"), "JPY")).sort()).toEqual(["51", "52"]);
    expect(await granted(tiers("highest"), cartOf(1_300_000, "JPY"), "JPY")).toEqual(["52"]);
  });
  it("the bar points at the next tier in cart units", async () => {
    const result = await run(tiers(), cartOf(800_000, "JPY"), "JPY");
    expect(result.progressBars[0]).toMatchObject({ currentCents: 800_000, targetCents: 1_200_000, isGoalReached: false });
  });
});

describe("cart_value_multiplier and order history on a JPY shop", () => {
  it("the multiplier counts 5000 yen steps", async () => {
    const offer = offerOf({ thresholdCents: 5000, currencyCode: "JPY" }, [gift("g", 0)], undefined, "cart_value_multiplier");
    expect(await qualified(offer, cartOf(500_000, "JPY"), "JPY")).toBe(true);
    expect(await qualified(offer, cartOf(5_000, "JPY"), "JPY")).toBe(false);
  });
  it("customer spend compares against whole yen", async () => {
    const offer = offerOf({ type: "total_spent", operator: "gte", valueCents: 20_000 }, [gift("g", 0)], undefined, "order_history_total_spent");
    const customer = (spentYen: number) => ({ id: "c", email: null, tags: [], totalSpentCents: spentYen * 100, totalOrders: 1, lastOrderSpentCents: null, countryCode: null, isFirstTimeCustomer: false });
    const cart = cartOf(500_000, "JPY");
    expect(await qualified(offer, cart, "JPY", { customer: customer(20_000) })).toBe(true);
    expect(await qualified(offer, cart, "JPY", { customer: customer(19_999) })).toBe(false);
  });
});

describe("two-decimal shops compare exactly as before", () => {
  it("USD: a 5000 cent threshold needs a 5000 cent cart", async () => {
    const offer = offerOf({ thresholdCents: 5000, currencyCode: "USD" }, [gift("g", 0)]);
    expect(await qualified(offer, cartOf(5_000, "USD"), "USD")).toBe(true);
    expect(await qualified(offer, cartOf(4_999, "USD"), "USD")).toBe(false);
  });
  it("USD shop with a EUR market still converts the threshold by the rate alone", async () => {
    const offer = offerOf({ thresholdCents: 5000, currencyCode: "USD" }, [gift("g", 0)]);
    const market = { id: "gid://shopify/Market/3", handle: "eu", currencyCode: "EUR", countryCode: "DE", primaryLocale: "de", exchangeRate: 0.9 };
    expect(await qualified(offer, cartOf(4_500, "EUR"), "USD", { market })).toBe(true);
    expect(await qualified(offer, cartOf(4_499, "EUR"), "USD", { market })).toBe(false);
  });
  it("a USD shop's JPY-market override is compared as stored, not lifted", async () => {
    const offer = offerOf({ thresholdCents: 5000, currencyCode: "USD", currencyOverrides: { JPY: 500_000 } }, [gift("g", 0)]);
    const market = { id: "gid://shopify/Market/4", handle: "jp", currencyCode: "JPY", countryCode: "JP", primaryLocale: "ja", exchangeRate: 150 };
    expect(await qualified(offer, cartOf(500_000, "JPY"), "USD", { market })).toBe(true);
    expect(await qualified(offer, cartOf(499_900, "JPY"), "USD", { market })).toBe(false);
  });
  it("EUR tiers and customer spend are unscaled", async () => {
    const tiered = offerOf({ thresholdCents: 5000, currencyCode: "EUR" }, [gift("51", 0, 5000), gift("52", 1, 12000)]);
    expect(await granted(tiered, cartOf(8_000, "EUR"), "EUR")).toEqual(["51"]);
    const spend = offerOf({ type: "total_spent", operator: "gte", valueCents: 20_000 }, [gift("g", 0)], undefined, "order_history_total_spent");
    const customer = { id: "c", email: null, tags: [], totalSpentCents: 20_000, totalOrders: 1, lastOrderSpentCents: null, countryCode: null, isFirstTimeCustomer: false };
    expect(await qualified(spend, cartOf(8_000, "EUR"), "EUR", { customer })).toBe(true);
  });
});
