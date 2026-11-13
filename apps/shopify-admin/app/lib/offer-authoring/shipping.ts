import { z } from "zod";
import { ShippingDiscountRewardPayloadSchema, validateRewardPayload, type ShippingDiscountTier } from "@promo/shared-types";
import { toStoredAmount } from "../money.js";
import type { AuthoringResult, StoredCondition, StoredCombinationPolicy, StoredReward, ToStored } from "./types.js";

/** Shipping offers are stored as offers.type "discount" with one shipping_discount reward (the wizard's choice). */
export const SHIPPING_OFFER_TYPE = "discount" as const;
export const SHIPPING_DEFAULT_PRIORITY = 100;

/** The wizard's templates: global = sitewide, landing = landing-page source, quiz = quiz bundle. */
export const SHIPPING_TEMPLATE_SCOPE = { global: "sitewide", landing: "landing", quiz: "quiz_bundle" } as const;
export type ShippingTemplate = keyof typeof SHIPPING_TEMPLATE_SCOPE;

/** What the shipping wizard writes to offer_combination_policies. */
export const SHIPPING_COMBINATION_POLICY: StoredCombinationPolicy = {
  combinesWithOrderDiscounts: true,
  combinesWithProductDiscounts: true,
  combinesWithShippingDiscounts: false,
  combinesWithOtherAppOffers: true,
  stopLowerPriority: false,
  giftValueCountsForOtherOffers: false,
};

const money = z.number().nonnegative();

export const AuthoringShippingTierSchema = z
  .object({
    minimumSubtotal: money.describe("Cart subtotal (shop currency, major units, e.g. 75 = $75) from which this tier applies."),
    maximumSubtotal: money.optional().describe("Optional upper bound of the subtotal bracket (major units)."),
    discountType: z.enum(["percentage", "fixed_amount"]).describe("percentage: value is 0-100 (100 = free shipping). fixed_amount: value is money off shipping in major units."),
    value: z.number().nonnegative().describe("Percentage (0-100) or amount in major units."),
    appliesWhen: z.enum(["has_subscription", "one_time_only"]).optional().describe("Optional: only when the cart has a subscription line / only one-time lines."),
  })
  .strict();

export const AuthoringShippingRewardSchema = z
  .object({
    kind: z.literal("shipping_discount"),
    tiers: z.array(AuthoringShippingTierSchema).min(1).max(20).describe("Shipping discount tiers by cart subtotal; the highest qualifying tier wins."),
    deliveryGroupTypes: z
      .array(z.enum(["one-time", "subscription"]))
      .min(1)
      .default(["one-time", "subscription"])
      .describe("Which deliveries the discount applies to. Default both."),
    template: z.enum(["global", "landing", "quiz"]).default("global").describe("global = sitewide; landing = only carts from a landing page source; quiz = quiz bundle."),
    landingSource: z.string().trim().optional().describe("template landing/quiz only: value of the __landing_source line property the cart must carry."),
    anchorVariantIds: z.array(z.string().trim().min(1)).optional().describe("template landing only: variant ids (GIDs) that must be in the cart."),
    anchorMinimum: z.number().int().positive().optional().describe("template landing only: minimum quantity of the anchor variants (default 1)."),
    anchorSubscription: z.boolean().optional().describe("template landing only: the anchor must be a subscription line."),
  })
  .strict();
export type AuthoringShippingReward = z.input<typeof AuthoringShippingRewardSchema>;

const DELIVERY_GROUP = { "one-time": "ONE_TIME_PURCHASE", subscription: "SUBSCRIPTION" } as const;

export type ShippingRewardParts = {
  tiers: ShippingDiscountTier[];
  deliveryGroupTypes: ("ONE_TIME_PURCHASE" | "SUBSCRIPTION")[];
  scopeMode: (typeof SHIPPING_TEMPLATE_SCOPE)[ShippingTemplate];
  landing?: { source: string; anchorVariantIds: string[]; anchorMinimum: number; anchorSubscription: boolean };
  currency: string;
};

/** The single place that turns wizard-level parts into the stored shipping reward; the admin wizard and the MCP both call it. */
export function buildShippingStoredReward(parts: ShippingRewardParts): AuthoringResult<StoredReward> {
  const target = {
    deliveryGroupTypes: parts.deliveryGroupTypes,
    scopeMode: parts.scopeMode,
    ...(parts.scopeMode === "landing" && parts.landing
      ? {
          requiredLineAttributeKey: "__landing_source" as const,
          requiredLineAttributeValue: parts.landing.source,
          requiredAnchorVariantIds: parts.landing.anchorVariantIds,
          requiredAnchorMinQuantity: parts.landing.anchorMinimum,
          requiresAnchorSubscription: parts.landing.anchorSubscription,
        }
      : {}),
  };
  const parsed = ShippingDiscountRewardPayloadSchema.safeParse({
    discountType: parts.tiers[0]?.discountType ?? "percentage",
    value: { amount: parts.tiers[0]?.discountValue ?? 0, currencyCode: parts.currency, tiers: parts.tiers },
    target,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid shipping configuration." };
  const payload = parsed.data;
  return {
    ok: true,
    value: {
      rewardType: "shipping_discount",
      discountType: payload.discountType,
      value: payload.value,
      target: payload.target,
      isAutoAdd: false,
      isCustomerSelectable: false,
      trackMode: "product",
      sortOrder: 0,
    },
  };
}

/** The wizard's main condition: cart subtotal >= the lowest tier minimum. */
export function shippingMainCondition(tiers: Pick<ShippingDiscountTier, "minimumSubtotalCents">[], currency: string): StoredCondition {
  return {
    scope: "main",
    conditionType: "cart_value",
    operator: "gte",
    value: {
      thresholdCents: Math.min(...tiers.map((tier) => tier.minimumSubtotalCents)),
      currencyCode: currency,
      includeGiftValues: false,
    },
    sortOrder: 0,
    isEnabled: true,
  };
}

/** Authoring shipping reward (major units) -> the stored reward the shipping wizard would write. */
export const toStoredShippingRewards: ToStored<z.input<typeof AuthoringShippingRewardSchema>, StoredReward[]> = async (input, deps) => {
  const parsedInput = AuthoringShippingRewardSchema.safeParse(input);
  if (!parsedInput.success) return { ok: false, error: parsedInput.error.issues[0]?.message ?? "Invalid shipping reward.", path: parsedInput.error.issues[0]?.path.join(".") };
  const reward = parsedInput.data;
  if (reward.template === "landing" && !reward.landingSource) return { ok: false, error: "landingSource is required for template landing.", path: "landingSource" };
  const tiers: ShippingDiscountTier[] = reward.tiers.map((tier) => ({
    minimumSubtotalCents: toStoredAmount(tier.minimumSubtotal, deps.shopCurrency),
    ...(tier.maximumSubtotal === undefined ? {} : { maximumSubtotalCents: toStoredAmount(tier.maximumSubtotal, deps.shopCurrency) }),
    discountType: tier.discountType,
    discountValue: tier.value,
    ...(tier.appliesWhen ? { appliesWhen: tier.appliesWhen } : {}),
  }));
  const built = buildShippingStoredReward({
    tiers,
    deliveryGroupTypes: [...new Set(reward.deliveryGroupTypes.map((type) => DELIVERY_GROUP[type]))],
    scopeMode: SHIPPING_TEMPLATE_SCOPE[reward.template],
    landing: {
      source: reward.landingSource ?? "",
      anchorVariantIds: reward.anchorVariantIds ?? [],
      anchorMinimum: reward.anchorMinimum ?? 1,
      anchorSubscription: reward.anchorSubscription ?? false,
    },
    currency: deps.shopCurrency,
  });
  if (!built.ok) return built;
  const check = validateRewardPayload(built.value.rewardType, built.value.discountType, built.value.value, built.value.target);
  if (!check.success) return { ok: false, error: check.error.issues[0]?.message ?? "Invalid shipping configuration." };
  return { ok: true, value: [built.value] };
};

/** Main condition for authored shipping tiers (major units in, as the wizard derives it). */
export function shippingMainConditionFromAuthoring(reward: AuthoringShippingReward, currency: string): StoredCondition {
  return shippingMainCondition(
    reward.tiers.map((tier) => ({ minimumSubtotalCents: toStoredAmount(tier.minimumSubtotal, currency) })),
    currency,
  );
}
