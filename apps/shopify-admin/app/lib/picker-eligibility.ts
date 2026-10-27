export type AvailabilityPolicy = "block" | "warn";
export type PickerReason = null | "sold_out" | "subscription_only";

interface EligibilityVariant {
  availableForSale: boolean;
  requiresSellingPlan: boolean;
}

/**
 * "block" is for gifts/upsells: sold-out variants stay selectable (flagged with the sold_out
 * warning; the storefront shows them as sold out until restocked) but subscription-only
 * variants are blocked because they can't be granted as a one-time gift.
 * "warn" is for discounts and conditions, which stay valid while a variant is sold out.
 * Product status (ACTIVE) is checked by the caller.
 */
export function variantEligibility(variant: EligibilityVariant, policy: AvailabilityPolicy): {
  selectable: boolean;
  reason: PickerReason;
  warning: null | "sold_out";
} {
  if (policy === "warn") {
    return { selectable: true, reason: null, warning: variant.availableForSale ? null : "sold_out" };
  }
  if (variant.requiresSellingPlan) return { selectable: false, reason: "subscription_only", warning: null };
  return { selectable: true, reason: null, warning: variant.availableForSale ? null : "sold_out" };
}
