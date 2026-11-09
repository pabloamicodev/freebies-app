import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator.js";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import type { OfferDefinition } from "./evaluator.js";

const line = (key: string, priceCents: number, quantity: number, properties: Record<string, string> = {}): NormalizedCartLine => ({
  key,
  variantId: `gid://shopify/ProductVariant/${key}`,
  productId: `gid://shopify/Product/${key}`,
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
const offer = (includeGiftValues: boolean): OfferDefinition => ({
  id: "offer-1",
  version: 1,
  type: "discount",
  priority: 100,
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [
    {
      id: "c",
      scope: "main",
      conditionType: "cart_quantity",
      operator: "gte",
      value: { minQuantity: 3, includeGiftValues },
      isEnabled: true,
      sortOrder: 0,
    },
  ],
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
});
const barFor = async (cart: NormalizedCart, includeGiftValues = false) => {
  const input: EvaluationInput = {
    shopDomain: "s.myshopify.com",
    cart,
    customer: null,
    market: null,
    locale: "en",
    salesChannel: "online_store",
    requestedUrl: null,
    sessionId: "s",
  };
  const result = await evaluate(input, { offers: [offer(includeGiftValues)], usageStates: [], now: new Date("2026-06-01T12:00:00Z") });
  return result.progressBars[0]!;
};

describe("cart_quantity progress bar", () => {
  it("counts what the condition checks: no $0 line", async () => {
    const bar = await barFor(cartOf(line("a", 1000, 2), line("free", 0, 1)));
    expect(bar.currentQuantity).toBe(2);
    expect(bar.isGoalReached).toBe(false);
  });

  it("leaves out promo gift lines", async () => {
    const bar = await barFor(cartOf(line("a", 1000, 2), line("g", 1000, 1, { _promo_engine_line_type: "gift" })));
    expect(bar.currentQuantity).toBe(2);
  });

  it("counts $0 and gift lines when includeGiftValues is true", async () => {
    const bar = await barFor(cartOf(line("a", 1000, 2), line("free", 0, 1)), true);
    expect(bar.currentQuantity).toBe(3);
    expect(bar.isGoalReached).toBe(true);
  });

  it("is unchanged for a cart with no $0 line", async () => {
    const bar = await barFor(cartOf(line("a", 1000, 2), line("b", 500, 1)));
    expect(bar.currentQuantity).toBe(3);
    expect(bar.isGoalReached).toBe(true);
  });
});
