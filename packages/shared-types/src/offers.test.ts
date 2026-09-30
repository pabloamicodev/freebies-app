import { describe, expect, it } from "vitest";
import {
  LineAttributeKeySchema,
  ProductDiscountTierSchema,
  resolveOnlyMatchedLines,
  ShippingDiscountTierSchema,
  SubtotalDiscountTierSchema,
  validateConditionValue,
  validateRequiredDiscountCode,
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

  it("accepts a cart_attribute condition in 'exists' matchMode without a value", () => {
    expect(
      validateConditionValue("cart_attribute", { key: "source", matchMode: "exists" }).success,
    ).toBe(true);
  });

  it("rejects a cart_attribute condition missing a value unless matchMode is 'exists'", () => {
    expect(validateConditionValue("cart_attribute", { key: "source", matchMode: "equals" }).success).toBe(
      false,
    );
  });

  it("accepts a discount_code condition and trims the code", () => {
    const result = validateConditionValue("discount_code", { code: "  PRIME2026  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ code: "PRIME2026" });
  });

  it("rejects a discount_code condition with an empty or missing code", () => {
    expect(validateConditionValue("discount_code", { code: "" }).success).toBe(false);
    expect(validateConditionValue("discount_code", { code: "   " }).success).toBe(false);
    expect(validateConditionValue("discount_code", {}).success).toBe(false);
  });

  it("rejects a discount_code longer than 255 characters", () => {
    expect(validateConditionValue("discount_code", { code: "A".repeat(256) }).success).toBe(false);
    expect(validateConditionValue("discount_code", { code: "A".repeat(255) }).success).toBe(true);
  });

  it("accepts a utm_parameters condition with at least one field set", () => {
    const result = validateConditionValue("utm_parameters", {
      utmSource: "amazon",
      utmCampaign: "primeday",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ utmSource: "amazon", utmCampaign: "primeday" });
    }
  });

  it("rejects a utm_parameters condition with every field blank", () => {
    expect(
      validateConditionValue("utm_parameters", {
        utmSource: "",
        utmMedium: "",
        utmCampaign: "",
        utmTerm: "",
        utmContent: "",
      }).success,
    ).toBe(false);
    expect(validateConditionValue("utm_parameters", {}).success).toBe(false);
  });

  it("rejects a utm_parameters field longer than 255 characters", () => {
    expect(
      validateConditionValue("utm_parameters", { utmSource: "A".repeat(256) }).success,
    ).toBe(false);
    expect(
      validateConditionValue("utm_parameters", { utmSource: "A".repeat(255) }).success,
    ).toBe(true);
  });

  it("accepts an optional boolean onlyMatchedLines on utm_parameters and page_url", () => {
    const pageUrl = { patterns: ["/pages/prime"], matchMode: "starts_with" };
    for (const onlyMatchedLines of [true, false, undefined]) {
      expect(
        validateConditionValue("utm_parameters", { utmSource: "amazon", onlyMatchedLines }).success,
      ).toBe(true);
      expect(validateConditionValue("page_url", { ...pageUrl, onlyMatchedLines }).success).toBe(true);
    }
    expect(
      validateConditionValue("utm_parameters", { utmSource: "amazon", onlyMatchedLines: "yes" }).success,
    ).toBe(false);
    expect(validateConditionValue("page_url", { ...pageUrl, onlyMatchedLines: 1 }).success).toBe(false);
  });
});

describe("resolveOnlyMatchedLines", () => {
  it("uses an explicit boolean, else defaults on only for checkout-code promos", () => {
    expect(resolveOnlyMatchedLines(true, false)).toBe(true);
    expect(resolveOnlyMatchedLines(false, true)).toBe(false);
    expect(resolveOnlyMatchedLines(undefined, true)).toBe(true);
    expect(resolveOnlyMatchedLines(undefined, false)).toBe(false);
  });
});

describe("validateRequiredDiscountCode", () => {
  it("trims and uppercases a valid code", () => {
    const result = validateRequiredDiscountCode("  primeday2026  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("PRIMEDAY2026");
  });

  it("rejects an empty string", () => {
    expect(validateRequiredDiscountCode("").success).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(validateRequiredDiscountCode("   ").success).toBe(false);
  });

  it("accepts exactly 255 characters and rejects 256", () => {
    expect(validateRequiredDiscountCode("A".repeat(255)).success).toBe(true);
    expect(validateRequiredDiscountCode("A".repeat(256)).success).toBe(false);
  });
});

describe("product reward targets", () => {
  it("accepts a requiredLineAttribute filter using a known line attribute key", () => {
    const result = validateRewardPayload("product_discount", "percentage", value, {
      productIds: ["gid://shopify/Product/1"],
      requiredLineAttribute: { key: "__bundle_type", value: "two" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a requiredLineAttribute filter with an empty value", () => {
    const result = validateRewardPayload("product_discount", "percentage", value, {
      productIds: ["gid://shopify/Product/1"],
      requiredLineAttribute: { key: "__bundle_type", value: "" },
    });
    expect(result.success).toBe(false);
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

  it("accepts a 0% shipping discount tier (highest qualifying tier can mean no discount)", () => {
    expect(
      ShippingDiscountTierSchema.safeParse({
        minimumSubtotalCents: 5_000,
        discountType: "percentage",
        discountValue: 0,
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

describe("validateRewardPayload attribute-unlocked rewards", () => {
  it("accepts a product allowlist on quiz_bundle and tagged_offer targets", () => {
    const value = { amount: 0, currencyCode: "USD" };
    expect(validateRewardPayload("product_discount", "fixed_price", value, {
      scopeMode: "quiz_bundle", scope: "cart", discountPercentageOnGifts: 100, productIds: ["gid://shopify/Product/1"],
    }).success).toBe(true);
    expect(validateRewardPayload("product_discount", "percentage", { amount: 10, currencyCode: "USD" }, {
      scopeMode: "tagged_offer", requiredOfferId: "11111111-1111-4111-8111-111111111111", variantIds: ["gid://shopify/ProductVariant/1"],
    }).success).toBe(true);
  });
});
