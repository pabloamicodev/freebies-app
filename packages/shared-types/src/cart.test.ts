import { describe, expect, it } from "vitest";
import { EvaluationInputSchema, type EvaluationInput } from "./cart.js";

function input(): EvaluationInput {
  return {
    shopDomain: "test.myshopify.com",
    cart: {
      token: "token",
      id: null,
      lines: [],
      subtotalCents: 0,
      discountCodes: [],
      currencyCode: "USD",
      totalQuantity: 0,
    },
    customer: null,
    market: null,
    locale: "en-US",
    salesChannel: "online_store",
    requestedUrl: "https://example.com/cart",
    sessionId: "session-1",
  };
}

describe("EvaluationInputSchema limits", () => {
  it("accepts a bounded storefront evaluation", () => {
    expect(EvaluationInputSchema.safeParse(input()).success).toBe(true);
  });

  it("rejects oversized carts before rule evaluation", () => {
    const payload = input();
    payload.cart.lines = Array.from({ length: 251 }, (_, index) => ({
      key: `line-${index}`,
      variantId: String(index),
      productId: String(index),
      quantity: 1,
      priceCents: 100,
      compareAtPriceCents: null,
      properties: {},
      requiresSellingPlan: false,
      sellingPlanId: null,
      productHandle: "product",
      productTitle: "Product",
      variantTitle: null,
      vendor: "Vendor",
      productType: "Type",
      tags: [],
      collections: [],
      availableForSale: true,
      inventoryPolicy: "DENY" as const,
      inventoryQuantity: 10,
    }));

    expect(EvaluationInputSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects malformed currency and oversized sessions", () => {
    const payload = input();
    payload.cart.currencyCode = "usd";
    payload.sessionId = "x".repeat(129);

    expect(EvaluationInputSchema.safeParse(payload).success).toBe(false);
  });
});
