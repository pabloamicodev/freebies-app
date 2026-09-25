import { describe, expect, it } from "vitest";
import {
  LineAttributeKeySchema,
  ProductDiscountTierSchema,
  ShippingDiscountTierSchema,
  SubtotalDiscountTierSchema,
  validateConditionValue,
  validateRewardPayload,
} from "./offers.js";

const value = { amount: 100, currencyCode: "USD" };

describe("validateRewardPayload product gifts", () => {
  it("accepts a free gift with strict Shopify variant GIDs", () => {
    const result = validateRewardPayload("product_gift", "free", value, {
      variantIds: ["gid://shopify/ProductVariant/123"],
    });

    expect(result.success).toBe(true);
  });

  it.each(["fixed_price", "cheapest_item_free", "most_expensive_item_discount"])(
    "rejects unsupported %s discount semantics for gifts",
    (discountType) => {
      const result = validateRewardPayload("product_gift", discountType, value, {
        variantId: "gid://shopify/ProductVariant/123",
      });

      expect(result.success).toBe(false);
    },
  );

  it("rejects ambiguous singular and plural gift targets", () => {
    const result = validateRewardPayload("product_gift", "free", value, {
      productId: "gid://shopify/Product/123",
      productIds: ["gid://shopify/Product/123"],
    });

    expect(result.success).toBe(false);
  });
});

describe("condition contracts", () => {
  it("requires Markets to be selected and prevents contradictory targeting", () => {
    expect(
      validateConditionValue("markets", {
        includeMarketIds: [],
        excludeMarketIds: [],
      }).success,
    ).toBe(false);
    expect(
      validateConditionValue("markets", {
        includeMarketIds: ["gid://shopify/Market/1"],
        excludeMarketIds: ["gid://shopify/Market/1"],
      }).success,
    ).toBe(false);
    expect(
      validateConditionValue("markets", {
        includeMarketIds: ["gid://shopify/Market/1"],
        excludeMarketIds: [],
      }).success,
    ).toBe(true);
  });

  it("accepts the canonical specific-link contract used by the evaluator", () => {
    expect(
      validateConditionValue("specific_link", {
        requiredUrl: "/pages/vip",
        paramName: "code",
        paramValue: "summer",
      }).success,
    ).toBe(true);
  });

  it.each(["__cart_gift_tier", "_quiz_target_cents", "_quiz_expected_paid_count"])(
    "keeps the HPN line attribute %s as a migration preset",
    (key) => expect(LineAttributeKeySchema.safeParse(key).success).toBe(true),
  );

  it("accepts store-specific line and cart attribute keys", () => {
    expect(
      validateConditionValue("line_attribute", {
        key: "engraving_message",
        value: "VIP",
        matchMode: "equals",
        minMatchingQuantity: 1,
      }).success,
    ).toBe(true);
    expect(
      validateConditionValue("cart_attribute", {
        key: "campaign source",
        value: "creator-42",
        matchMode: "equals",
      }).success,
    ).toBe(true);
  });
});

describe("tier contracts", () => {
  it("accepts inclusive minimum and maximum bounds for shipping tiers", () => {
    expect(
      ShippingDiscountTierSchema.safeParse({
        minimumSubtotalCents: 5_000,
        maximumSubtotalCents: 9_999,
        discountType: "percentage",
        discountValue: 50,
        appliesWhen: "one_time_only",
      }).success,
    ).toBe(true);
  });

  it("rejects an upper tier bound below its lower bound", () => {
    expect(
      ShippingDiscountTierSchema.safeParse({
        minimumSubtotalCents: 10_000,
        maximumSubtotalCents: 9_999,
        discountType: "percentage",
        discountValue: 50,
      }).success,
    ).toBe(false);
  });

  it("supports bounded quantity and subtotal discount tiers", () => {
    expect(
      ProductDiscountTierSchema.parse({
        minimumQuantity: 2,
        maximumQuantity: 4,
        discountType: "percentage",
        discountValue: 15,
        discountedQuantity: 2,
      }),
    ).toMatchObject({ minimumQuantity: 2, maximumQuantity: 4 });
    expect(
      SubtotalDiscountTierSchema.parse({
        minimumSubtotalCents: 5_000,
        maximumSubtotalCents: 9_999,
        discountType: "fixed_amount",
        discountValue: 10,
      }),
    ).toMatchObject({ minimumSubtotalCents: 5_000, maximumSubtotalCents: 9_999 });
  });
});
