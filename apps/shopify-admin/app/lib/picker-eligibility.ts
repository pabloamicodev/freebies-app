export type AvailabilityPolicy = "block" | "warn";
export type PickerReason = null | "sold_out" | "subscription_only";

interface EligibilityVariant {
  availableForSale: boolean;
  requiresSellingPlan: boolean;
}

/**
 * "block" is for gifts/upsells: the server only grants variants that can be sold.
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
  const reason = !variant.availableForSale ? "sold_out" : variant.requiresSellingPlan ? "subscription_only" : null;
  return { selectable: reason === null, reason, warning: null };
}
