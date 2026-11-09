import type { CurrencyContext, NormalizedCart } from "@promo/shared-types";
import { evaluateCartValue } from "./conditions/cart-value.js";
import type { OfferDefinition } from "./evaluator.js";

export interface GiftTierState {
  /** Gift rewards the cart does not get right now: threshold unmet, or a lower tier in "highest" mode. */
  unmetRewardIds: Set<string>;
  currentCents: number;
  /** The closest threshold above the cart, in the cart's currency; null once every tier is reached. */
  nextThresholdCents: number | null;
  topThresholdCents: number;
}

/**
 * Null when no gift reward has a tier, so offers without tiers skip all of this.
 * Measures what the Function measures: non-gift lines minus the offer's excluded products.
 */
export function giftTierState(
  offer: OfferDefinition,
  cart: NormalizedCart,
  currency: CurrencyContext,
  excludedProductIds: ReadonlySet<string>,
): GiftTierState | null {
  const gifts = offer.rewards.filter((reward) => reward.rewardType === "product_gift");
  if (!gifts.some((reward) => (reward.minCartSubtotalCents ?? 0) > 0)) return null;

  const measure = (thresholdCents: number) => {
    const result = evaluateCartValue(
      cart,
      {
        thresholdCents,
        currencyCode: currency.shopCurrencyCode,
        includeGiftValues: false,
        ...(excludedProductIds.size > 0 ? { scopeFilter: { excludeProductIds: [...excludedProductIds] } } : {}),
      },
      currency,
    );
    const reason = result.ok ? result.value : result.error;
    return { met: result.ok, requiredCents: Number(reason.required ?? 0), currentCents: Number(reason.actual ?? 0) };
  };

  const tiers = gifts.map((reward) => ({ id: reward.id, ...measure(reward.minCartSubtotalCents ?? 0) }));
  const metThresholds = tiers.filter((tier) => tier.met).map((tier) => tier.requiredCents);
  const floor = offer.tierMode === "highest" && metThresholds.length > 0 ? Math.max(...metThresholds) : 0;
  const above = tiers.filter((tier) => !tier.met).map((tier) => tier.requiredCents);
  return {
    unmetRewardIds: new Set(tiers.filter((tier) => !tier.met || tier.requiredCents < floor).map((tier) => tier.id)),
    currentCents: tiers[0]?.currentCents ?? 0,
    nextThresholdCents: above.length > 0 ? Math.min(...above) : null,
    topThresholdCents: Math.max(...tiers.map((tier) => tier.requiredCents)),
  };
}
