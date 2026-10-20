import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import { extractQualifyingLines } from "./cart-parser.js";
import type { ConditionDefinition, OfferDefinition, RewardDefinition } from "./evaluator.js";
import { isPageConditionType, lineMatchesPageConditions } from "./page-match.js";

/** Cart lines whose units unlock a gift offer, and how many units unlocking takes. */
export interface Anchors {
  lines: Array<{ key: string; quantity: number }>;
  needed: number;
}

interface AnchorRequirement {
  productId?: string;
  variantId?: string;
  trackMode?: string;
  minQuantity: number;
  /** "any" trigger: qualifies on presence, so it adds no units to what unlocking takes. */
  presenceOnly: boolean;
}

type RawRequirement = { productId?: string; variantId?: string; trackMode?: string; minQuantity?: number; quantityPerPack?: number };

const isSubscription = (line: NormalizedCartLine) => line.requiresSellingPlan || line.sellingPlanId !== null;

function requirementsOf(conditions: ConditionDefinition[]): AnchorRequirement[] {
  return conditions.flatMap((cond) => {
    if (!cond.isEnabled || (cond.conditionType !== "specific_product" && cond.conditionType !== "pack_of_products")) return [];
    const value = (cond.value ?? {}) as { requirements?: RawRequirement[]; variantIds?: string[]; minQtyPerProduct?: number };
    const presenceOnly = cond.conditionType === "specific_product" && cond.operator === "any";
    const requirements = (value.requirements ?? []).map((req) => ({
      ...req,
      minQuantity: Math.max(1, Number(cond.conditionType === "pack_of_products" ? req.quantityPerPack : req.minQuantity) || 1),
      presenceOnly,
    }));
    const legacy = (value.variantIds ?? []).map((variantId) => ({
      variantId,
      trackMode: "variant",
      minQuantity: Math.max(1, value.minQtyPerProduct ?? 1),
      presenceOnly,
    }));
    return [...requirements, ...legacy];
  });
}

function productGiftAnchors(offer: OfferDefinition, lines: NormalizedCartLine[], excluded: Set<string>): Anchors | null {
  const requirements = requirementsOf(offer.conditions);
  const pageConditions = offer.conditions.filter((c) => c.isEnabled && isPageConditionType(c.conditionType));
  if (requirements.length === 0 && pageConditions.length === 0) return null;
  const subscriptionMode = (
    offer.conditions.find((c) => c.isEnabled && c.conditionType === "subscription_product_type")?.value as { mode?: string } | undefined
  )?.mode;
  const anchors = lines
    .filter((line) => line.quantity > 0 && !excluded.has(line.productId))
    .filter((line) => subscriptionMode !== "subscription_only" || isSubscription(line))
    .filter((line) => subscriptionMode !== "one_time_only" || !isSubscription(line))
    .filter((line) => pageConditions.length === 0 || lineMatchesPageConditions(line.properties, pageConditions))
    .filter(
      (line) =>
        requirements.length === 0 ||
        requirements.some((req) => (req.trackMode === "variant" ? req.variantId === line.variantId : req.productId === line.productId)),
    );
  return {
    lines: anchors.map((line) => ({ key: line.key, quantity: line.quantity })),
    needed: Math.max(1, requirements.filter((req) => !req.presenceOnly).reduce((sum, req) => sum + req.minQuantity, 0)),
  };
}

type LandingTarget = {
  scopeMode?: string;
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds?: string[];
  requiredAnchorMinQuantity?: number;
  requiresAnchorSubscription?: boolean;
  subscriptionMode?: string;
  priceTiers?: unknown[];
  productIds?: string[];
  productId?: string;
  variantIds?: string[];
  variantId?: string;
};

const isFreeLandingGift = (reward: RewardDefinition): boolean => {
  const target = (reward.target ?? {}) as LandingTarget;
  const value = (reward.value ?? {}) as { amount?: number; tiers?: unknown[] };
  return (
    reward.rewardType === "product_discount" &&
    target.scopeMode === "landing" &&
    !target.priceTiers?.length &&
    !value.tiers?.length &&
    (reward.discountType === "free" || (reward.discountType === "percentage" && Number(value.amount) >= 100))
  );
};

function landingAnchors(reward: RewardDefinition, lines: NormalizedCartLine[]): Anchors | null {
  const target = reward.target as LandingTarget;
  if (typeof target.requiredLineAttributeValue !== "string") return null;
  const anchorVariantIds = target.requiredAnchorVariantIds ?? [];
  const ownProductIds = target.productIds ?? (target.productId ? [target.productId] : []);
  const ownVariantIds = target.variantIds ?? (target.variantId ? [target.variantId] : []);
  // A free landing gift is a one-time line, so "subscriptions only" applies to the anchor the shopper buys.
  const needsSubscription = target.requiresAnchorSubscription === true || target.subscriptionMode === "subscription_only";
  const anchors = lines
    .filter((line) => line.properties["__landing_source"] === target.requiredLineAttributeValue)
    .filter((line) =>
      anchorVariantIds.length === 0
        ? !ownProductIds.includes(line.productId) && !ownVariantIds.includes(line.variantId)
        : anchorVariantIds.includes(line.variantId),
    )
    .filter((line) => !needsSubscription || isSubscription(line));
  return {
    lines: anchors.map((line) => ({ key: line.key, quantity: line.quantity })),
    needed: Math.max(1, Number(target.requiredAnchorMinQuantity ?? 1)),
  };
}

/** Null when the offer is not a gift offer or has no identifiable anchor lines (it then never consumes or is gated). */
export function giftAnchors(offer: OfferDefinition, cart: NormalizedCart, excluded: Set<string>): Anchors | null {
  const lines = extractQualifyingLines(cart);
  if (offer.rewards.some((reward) => reward.rewardType === "product_gift")) return productGiftAnchors(offer, lines, excluded);
  const landing = offer.rewards.find(isFreeLandingGift);
  return landing ? landingAnchors(landing, lines) : null;
}

export function freeUnits(anchors: Anchors, consumed: Map<string, number>): number {
  return anchors.lines.reduce((sum, line) => sum + line.quantity - (consumed.get(line.key) ?? 0), 0);
}

/** Takes the units an unlocked offer needs from its anchors, in cart order. */
export function consumeAnchors(anchors: Anchors, consumed: Map<string, number>): void {
  let left = anchors.needed;
  for (const line of anchors.lines) {
    const taken = Math.max(0, Math.min(left, line.quantity - (consumed.get(line.key) ?? 0)));
    consumed.set(line.key, (consumed.get(line.key) ?? 0) + taken);
    left -= taken;
  }
}
