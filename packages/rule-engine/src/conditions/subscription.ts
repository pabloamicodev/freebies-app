import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";

export type SubscriptionFilterMode = "any" | "subscription_only" | "one_time_only";

export interface SubscriptionConditionValue {
  mode: SubscriptionFilterMode;
}

/**
 * Filter cart lines by subscription status.
 * "subscription_only" — only lines with a selling plan qualify.
 * "one_time_only" — only lines without a selling plan qualify.
 * "any" — always passes (default).
 */
export function evaluateSubscriptionCondition(
  cart: NormalizedCart,
  condition: SubscriptionConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  if (condition.mode === "any") {
    return ok({ conditionType: "subscription_product_type", passed: true, message: "Any subscription type allowed" });
  }

  const qualifyingLines = cart.lines.filter((l) => {
    const isGift = l.properties["_promo_engine_line_type"] === "gift";
    if (isGift) return false;
    if (condition.mode === "subscription_only") return l.requiresSellingPlan || l.sellingPlanId !== null;
    if (condition.mode === "one_time_only") return !l.requiresSellingPlan && l.sellingPlanId === null;
    return true;
  });

  const passed = qualifyingLines.length > 0;
  const reason: EligibilityReason = {
    conditionType: "subscription_product_type",
    passed,
    message: passed
      ? `${qualifyingLines.length} qualifying line(s) for mode "${condition.mode}"`
      : `No qualifying lines for mode "${condition.mode}"`,
    actual: qualifyingLines.length,
    required: 1,
  };

  return passed ? ok(reason) : err(reason);
}
