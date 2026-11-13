import { describe, expect, it } from "vitest";
import { validateRewardPayload } from "@promo/shared-types";
import {
  buildShippingStoredReward,
  shippingMainCondition,
  shippingMainConditionFromAuthoring,
  toStoredShippingRewards,
  SHIPPING_OFFER_TYPE,
} from "./shipping.js";
import type { AuthoringDeps } from "./types.js";

const deps = { shopCurrency: "USD", timezone: "UTC", shopId: "s", shopDomain: "x.myshopify.com", db: {} as never } as AuthoringDeps;

// What the shipping wizard action stored before this module existed (golden, written by hand from the old inline code).
const wizardReward = (value: Record<string, unknown>, target: Record<string, unknown>, discountType: string) => ({
  rewardType: "shipping_discount",
  discountType,
  value,
  target,
  isAutoAdd: false,
  isCustomerSelectable: false,
  trackMode: "product",
  sortOrder: 0,
});

describe("shipping authoring", () => {
  it("tiered global offer stores exactly what the wizard stores", async () => {
    const result = await toStoredShippingRewards(
      {
        kind: "shipping_discount",
        tiers: [
          { minimumSubtotal: 50, maximumSubtotal: 99.99, discountType: "fixed_amount", value: 4.5 },
          { minimumSubtotal: 100, discountType: "percentage", value: 100, appliesWhen: "has_subscription" },
        ],
      },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        wizardReward(
          {
            amount: 4.5,
            currencyCode: "USD",
            tiers: [
              { minimumSubtotalCents: 5000, maximumSubtotalCents: 9999, discountType: "fixed_amount", discountValue: 4.5 },
              { minimumSubtotalCents: 10000, discountType: "percentage", discountValue: 100, appliesWhen: "has_subscription" },
            ],
          },
          { deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"], scopeMode: "sitewide" },
          "fixed_amount",
        ),
      ],
    });
  });

  it("landing template adds the landing target and anchors", async () => {
    const result = await toStoredShippingRewards(
      {
        kind: "shipping_discount",
        tiers: [{ minimumSubtotal: 0, discountType: "percentage", value: 100 }],
        deliveryGroupTypes: ["subscription"],
        template: "landing",
        landingSource: "quiz-a",
        anchorVariantIds: ["gid://shopify/ProductVariant/1"],
        anchorMinimum: 2,
        anchorSubscription: true,
      },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        wizardReward(
          { amount: 100, currencyCode: "USD", tiers: [{ minimumSubtotalCents: 0, discountType: "percentage", discountValue: 100 }] },
          {
            deliveryGroupTypes: ["SUBSCRIPTION"],
            scopeMode: "landing",
            requiredLineAttributeKey: "__landing_source",
            requiredLineAttributeValue: "quiz-a",
            requiredAnchorVariantIds: ["gid://shopify/ProductVariant/1"],
            requiredAnchorMinQuantity: 2,
            requiresAnchorSubscription: true,
          },
          "percentage",
        ),
      ],
    });
  });

  it("the stored reward passes validateRewardPayload and the offer is a discount with the wizard's main condition", async () => {
    const result = await toStoredShippingRewards({ kind: "shipping_discount", tiers: [{ minimumSubtotal: 75, discountType: "percentage", value: 100 }], template: "quiz" }, deps);
    if (!result.ok) throw new Error(result.error);
    const [reward] = result.value;
    expect(validateRewardPayload(reward!.rewardType, reward!.discountType, reward!.value, reward!.target).success).toBe(true);
    expect(SHIPPING_OFFER_TYPE).toBe("discount");
    expect(shippingMainConditionFromAuthoring({ kind: "shipping_discount", tiers: [{ minimumSubtotal: 75, discountType: "percentage", value: 100 }] }, "USD")).toEqual({
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents: 7500, currencyCode: "USD", includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    });
    expect(shippingMainCondition([{ minimumSubtotalCents: 900 }, { minimumSubtotalCents: 300 }], "USD").value["thresholdCents"]).toBe(300);
  });

  it("rejects what the wizard rejects", async () => {
    const landingWithoutSource = await toStoredShippingRewards({ kind: "shipping_discount", tiers: [{ minimumSubtotal: 0, discountType: "percentage", value: 100 }], template: "landing" }, deps);
    expect(landingWithoutSource).toMatchObject({ ok: false, error: "landingSource is required for template landing." });
    const over100 = await toStoredShippingRewards({ kind: "shipping_discount", tiers: [{ minimumSubtotal: 0, discountType: "percentage", value: 120 }] }, deps);
    expect(over100).toMatchObject({ ok: false, error: "Shipping discount percentage cannot exceed 100%." });
    expect(buildShippingStoredReward({ tiers: [], deliveryGroupTypes: [], scopeMode: "sitewide", currency: "USD" }).ok).toBe(false);
  });

  it("zero-decimal currencies keep minimums whole", async () => {
    const result = await toStoredShippingRewards({ kind: "shipping_discount", tiers: [{ minimumSubtotal: 5000, discountType: "percentage", value: 50 }] }, { ...deps, shopCurrency: "JPY" });
    if (!result.ok) throw new Error(result.error);
    expect((result.value[0]!.value as { tiers: { minimumSubtotalCents: number }[] }).tiers[0]!.minimumSubtotalCents).toBe(5000);
  });
});
