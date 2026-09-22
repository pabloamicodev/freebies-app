import { describe, expect, it } from "vitest";
import { validateRewardPayload } from "@promo/shared-types";
import {
  compileOfferConfig,
  compileShippingOfferConfigs,
  type CompiledShippingOffer,
} from "./compile-config.js";

type CompileArgs = Parameters<typeof compileShippingOfferConfigs>;

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const REWARD_ID = "22222222-2222-4222-8222-222222222222";

function offer(overrides: Record<string, unknown> = {}): CompileArgs[0] {
  return {
    id: OFFER_ID,
    type: "discount",
    priority: 7,
    ...overrides,
  } as CompileArgs[0];
}

function condition(
  conditionType: string,
  value: Record<string, unknown>,
  operator = "gte",
): CompileArgs[1][number] {
  return {
    conditionType,
    value,
    operator,
    isEnabled: true,
  } as CompileArgs[1][number];
}

function shippingReward(overrides: Record<string, unknown> = {}): CompileArgs[2][number] {
  return {
    id: REWARD_ID,
    rewardType: "shipping_discount",
    discountType: "percentage",
    value: { amount: 100, currencyCode: "USD" },
    target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"] },
    sortOrder: 0,
    ...overrides,
  } as CompileArgs[2][number];
}

describe("compileShippingOfferConfigs", () => {
  it("compiles arbitrary subtotal and subscription-aware tiers", () => {
    const result = compileShippingOfferConfigs(
      offer(),
      [condition("cart_value", { thresholdCents: 1000 })],
      [shippingReward({
        value: {
          amount: 25,
          currencyCode: "USD",
          tiers: [
            {
              minimumSubtotalCents: 2500,
              discountType: "percentage",
              discountValue: 25,
              appliesWhen: "one_time_only",
            },
            {
              minimumSubtotalCents: 5000,
              discountType: "fixed_amount",
              discountValue: 8,
              appliesWhen: "has_subscription",
            },
          ],
        },
        target: { deliveryGroupTypes: ["SUBSCRIPTION"] },
      })],
    );

    expect(result).toEqual<CompiledShippingOffer[]>([{
      id: `${OFFER_ID}:${REWARD_ID}`,
      priority: 7000,
      targetGroupTypes: ["SUBSCRIPTION"],
      scopeMode: "sitewide",
      requiredAnchorVariantIds: [],
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: false,
      tiers: [
        {
          minimumSubtotalCents: 2500,
          discountType: "percentage",
          discountValue: 25,
          appliesWhen: "one_time_only",
        },
        {
          minimumSubtotalCents: 5000,
          discountType: "fixed_amount",
          discountValue: 8,
          appliesWhen: "has_subscription",
        },
      ],
    }]);
  });

  it("uses the cart-value condition for a legacy single-value reward", () => {
    const result = compileShippingOfferConfigs(
      offer({ priority: 2 }),
      [condition("cart_value", { thresholdCents: 8500 })],
      [shippingReward({ discountType: "free" })],
    );

    expect(result[0]).toMatchObject({
      priority: 2000,
      targetGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"],
      tiers: [{
        minimumSubtotalCents: 8500,
        discountType: "percentage",
        discountValue: 100,
      }],
    });
  });

  it("does not emit shipping config for other reward types", () => {
    const result = compileShippingOfferConfigs(
      offer(),
      [condition("cart_value", { thresholdCents: 1000 })],
      [shippingReward({ rewardType: "product_gift" })],
    );

    expect(result).toEqual([]);
  });
});

describe("compileOfferConfig", () => {
  it("preserves exact requirements and compiles product and order rewards", () => {
    const result = compileOfferConfig(
      offer(),
      [
        condition("specific_product", {
          requirements: [{
            variantId: "gid://shopify/ProductVariant/trigger",
            trackMode: "variant",
            minQuantity: 2,
            maxQuantity: 3,
          }],
        }),
        condition("order_history_total_orders", { type: "total_orders", value: 3 }),
        condition("order_history_total_spent", { type: "total_spent", valueCents: 10_000 }, "lt"),
      ],
      [
        shippingReward({
          id: "33333333-3333-4333-8333-333333333333",
          rewardType: "product_discount",
          discountType: "fixed_amount",
          value: { amount: 500, currencyCode: "USD" },
          target: {
            variantIds: ["gid://shopify/ProductVariant/target"],
            lineQuantityEquals: 1,
            maxUnitsTotal: 2,
            subscriptionMode: "one_time_only",
            scopeMode: "sitewide",
          },
          quantity: null,
        }),
        shippingReward({
          id: "44444444-4444-4444-8444-444444444444",
          rewardType: "order_discount",
          discountType: "percentage",
          value: { amount: 15, currencyCode: "USD" },
          target: { scope: "cart" },
        }),
      ],
      null,
      1,
    );

    expect(result.requirements).toEqual([{
      variantId: "gid://shopify/ProductVariant/trigger",
      trackMode: "variant",
      minQuantity: 2,
      maxQuantity: 3,
    }]);
    expect(result.productRewards).toEqual([expect.objectContaining({
      targetVariantIds: ["gid://shopify/ProductVariant/target"],
      discountType: "fixed_amount",
      discountValue: 5,
      lineQuantityEquals: 1,
      maxUnitsTotal: 2,
      subscriptionMode: "one_time_only",
    })]);
    expect(result.orderRewards).toEqual([expect.objectContaining({
      discountType: "percentage",
      discountValue: 15,
    })]);
    expect(result.customerOrderCountMin).toBe(3);
    expect(result.customerAmountSpentMaxCents).toBe(9_999);
  });
});

describe("shipping reward validation", () => {
  it("rejects percentages above 100 and empty delivery targeting", () => {
    const result = validateRewardPayload(
      "shipping_discount",
      "percentage",
      {
        amount: 100,
        currencyCode: "USD",
        tiers: [{
          minimumSubtotalCents: 0,
          discountType: "percentage",
          discountValue: 101,
        }],
      },
      { deliveryGroupTypes: [] },
    );

    expect(result.success).toBe(false);
  });
});

describe("product reward scope validation", () => {
  const value = { amount: 100, currencyCode: "USD" };

  it("requires the landing marker and rejects landing-only fields on sitewide rewards", () => {
    expect(validateRewardPayload("product_discount", "percentage", value, {
      scopeMode: "landing",
      scope: "cart",
      requiredLineAttributeKey: "__landing_source",
      requiredLineAttributeValue: "",
      subscriptionMode: "any",
    }).success).toBe(false);

    expect(validateRewardPayload("product_discount", "percentage", value, {
      scopeMode: "sitewide",
      scope: "cart",
      subscriptionMode: "any",
      requiredLineAttributeValue: "forged-landing",
    }).success).toBe(false);
  });

  it("keeps quiz rewards property-driven instead of accepting arbitrary product targets", () => {
    expect(validateRewardPayload("product_discount", "free", value, {
      scopeMode: "quiz_bundle",
      scope: "cart",
      discountPercentageOnGifts: 100,
      variantIds: ["gid://shopify/ProductVariant/not-allowed"],
    }).success).toBe(false);

    expect(validateRewardPayload("product_discount", "free", value, {
      scopeMode: "quiz_bundle",
      scope: "cart",
      discountPercentageOnGifts: 100,
    }).success).toBe(true);
  });

  it("applies strict targets to gifts, orders, bundles, and upsells", () => {
    expect(validateRewardPayload("product_gift", "free", value, {
      scope: "cart",
      variantIds: ["gid://shopify/ProductVariant/gift"],
      requiredLineAttributeValue: "not-allowed",
    }).success).toBe(false);
    expect(validateRewardPayload("order_discount", "percentage", value, {
      scope: "cart",
      variantIds: ["gid://shopify/ProductVariant/not-an-order-target"],
    }).success).toBe(false);
    expect(validateRewardPayload("bundle_discount", "percentage", value, {
      variantIds: ["gid://shopify/ProductVariant/bundle"],
    }).success).toBe(true);
    expect(validateRewardPayload("upsell_discount", "percentage", value, {
      variantIds: ["gid://shopify/ProductVariant/upsell"],
      discountPercentageOnGifts: 100,
    }).success).toBe(false);
  });
});
