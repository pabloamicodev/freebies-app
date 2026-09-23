import { describe, expect, it } from "vitest";
import { validateRewardPayload } from "./offers.js";

const value = { amount: 100, currencyCode: "USD" };

describe("validateRewardPayload product gifts", () => {
  it("accepts a free gift with strict Shopify variant GIDs", () => {
    const result = validateRewardPayload(
      "product_gift",
      "free",
      value,
      { variantIds: ["gid://shopify/ProductVariant/123"] },
    );

    expect(result.success).toBe(true);
  });

  it.each(["fixed_price", "cheapest_item_free", "most_expensive_item_discount"])(
    "rejects unsupported %s discount semantics for gifts",
    (discountType) => {
      const result = validateRewardPayload(
        "product_gift",
        discountType,
        value,
        { variantId: "gid://shopify/ProductVariant/123" },
      );

      expect(result.success).toBe(false);
    },
  );

  it("rejects ambiguous singular and plural gift targets", () => {
    const result = validateRewardPayload(
      "product_gift",
      "free",
      value,
      {
        productId: "gid://shopify/Product/123",
        productIds: ["gid://shopify/Product/123"],
      },
    );

    expect(result.success).toBe(false);
  });
});
