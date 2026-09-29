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

  it("coerces numeric/boolean cart attributes instead of rejecting the payload (Heatmap.com writes _heatIdSite/_heatDevice as numbers)", () => {
    const payload = input();
    (payload.cart as { attributes?: Record<string, unknown> }).attributes = {
      _heatIdSite: 4594,
      _heatDevice: 1,
      isGuest: true,
    };

    const result = EvaluationInputSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cart.attributes).toEqual({
        _heatIdSite: "4594",
        _heatDevice: "1",
        isGuest: "true",
      });
    }
  });

  it("coerces numeric/boolean line properties the same way", () => {
    const payload = input();
    payload.cart.lines = [
      {
        key: "line-1",
        variantId: "1",
        productId: "1",
        quantity: 1,
        priceCents: 100,
        compareAtPriceCents: null,
        properties: { _customNumericProp: 42 } as unknown as Record<string, string>,
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
        inventoryPolicy: "DENY",
        inventoryQuantity: 10,
      },
    ];

    const result = EvaluationInputSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cart.lines[0]?.properties).toEqual({ _customNumericProp: "42" });
    }
  });
});
