import { z } from "zod";

export const OfferTypeSchema = z.enum([
  "gift",
  "bundle",
  "upsell",
  "discount",
  "booster",
]);
export type OfferType = z.infer<typeof OfferTypeSchema>;

export const OfferStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "scheduled",
  "expired",
  "archived",
]);
export type OfferStatus = z.infer<typeof OfferStatusSchema>;

export const GiftLogicModeSchema = z.enum(["function", "clone_product", "hybrid"]);
export type GiftLogicMode = z.infer<typeof GiftLogicModeSchema>;

export const ConditionScopeSchema = z.enum(["main", "sub", "quantity_limit", "visibility"]);
export type ConditionScope = z.infer<typeof ConditionScopeSchema>;

export const ConditionOperatorSchema = z.enum([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "between", "in", "not_in", "contains", "not_contains", "all", "any",
]);
export type ConditionOperator = z.infer<typeof ConditionOperatorSchema>;

export const ConditionTypeSchema = z.enum([
  "cart_value",
  "cart_quantity",
  "specific_product",
  "cart_value_multiplier",
  "pack_of_products",
  "specific_link",
  "order_history_total_spent",
  "order_history_last_order_spent",
  "order_history_total_orders",
  "one_use_per_customer",
  "customer_tags",
  "customer_location",
  "markets",
  "subscription_product_type",
  "sales_channels",
  "product_quantity_limits",
  "collection_quantity_limits",
  "vendor_quantity_limits",
  "product_type_quantity_limits",
  "exclude_products",
  "exclude_collections",
  "exclude_vendors",
  "exclude_types",
]);
export type ConditionType = z.infer<typeof ConditionTypeSchema>;

export const RewardTypeSchema = z.enum([
  "product_gift",
  "shipping_discount",
  "product_discount",
  "order_discount",
  "bundle_discount",
  "upsell_discount",
]);
export type RewardType = z.infer<typeof RewardTypeSchema>;

export const DiscountTypeSchema = z.enum([
  "percentage",
  "fixed_amount",
  "fixed_price",
  "free",
  "cheapest_item_free",
  "most_expensive_item_discount",
]);
export type DiscountType = z.infer<typeof DiscountTypeSchema>;

export const WidgetTypeSchema = z.enum([
  "gift_slider",
  "gift_popup",
  "cart_message",
  "today_offer_widget",
  "today_offer_block",
  "progress_bar",
  "gift_icon",
  "gift_thumbnail",
  "classic_bundle",
  "mix_match_bundle",
  "bundle_page",
  "checkout_upsell",
  "fbt",
  "thank_you_upsell",
  "volume_discount",
]);
export type WidgetType = z.infer<typeof WidgetTypeSchema>;

export const TrackModeSchema = z.enum(["product", "variant"]);
export type TrackMode = z.infer<typeof TrackModeSchema>;

export const SpecificProductRequirementSchema = z.object({
  productId: z.string().optional(),
  variantId: z.string().optional(),
  trackMode: TrackModeSchema.default("variant"),
  minQuantity: z.number().int().positive().default(1),
  maxQuantity: z.number().int().positive().optional(),
}).refine((value) => value.productId || value.variantId, {
  message: "A product or variant id is required.",
});

export const CartValueConditionValueSchema = z.object({
  thresholdCents: z.number().int().nonnegative(),
  maxCents: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).default("USD"),
  currencyOverrides: z.record(z.string(), z.number().int().nonnegative()).optional(),
  includeGiftValues: z.boolean().default(false),
  appliesTo: z.string().optional(),
  scopeFilter: z.record(z.string(), z.array(z.string())).optional(),
});

export const CartQuantityConditionValueSchema = z.object({
  minQuantity: z.number().int().positive(),
  maxQuantity: z.number().int().positive().optional(),
  includeGiftValues: z.boolean().default(false),
  appliesTo: z.string().optional(),
}).refine((value) => value.maxQuantity === undefined || value.maxQuantity >= value.minQuantity, {
  message: "Maximum quantity must be greater than or equal to minimum quantity.",
});

export const SpecificProductConditionValueSchema = z.object({
  requirements: z.array(SpecificProductRequirementSchema).min(1),
  multiplyByGroups: z.boolean().default(false),
});

export const PackConditionValueSchema = z.object({
  requirements: z.array(z.object({
    productId: z.string().optional(),
    variantId: z.string().optional(),
    trackMode: TrackModeSchema.default("variant"),
    quantityPerPack: z.number().int().positive(),
  }).refine((value) => value.productId || value.variantId, {
    message: "A product or variant id is required.",
  })).min(1),
  multiplyByPacks: z.boolean().default(false),
  maxPacks: z.number().int().positive().optional(),
});

export const CustomerTagsConditionValueSchema = z.object({
  includeTags: z.array(z.string()).default([]),
  excludeTags: z.array(z.string()).default([]),
  treatGuestAsNoTags: z.boolean().default(true),
});

export const OrderHistoryConditionValueSchema = z.object({
  type: z.enum(["total_spent", "last_order_spent", "total_orders"]),
  operator: z.string().default("gte"),
  valueCents: z.number().int().nonnegative().optional(),
  value: z.number().int().nonnegative().optional(),
});

export const MarketConditionValueSchema = z.object({
  includeMarketIds: z.array(z.string()).default([]),
  excludeMarketIds: z.array(z.string()).default([]),
});

export const CountryConditionValueSchema = z.object({
  includeCountryCodes: z.array(z.string().length(2)).default([]),
  excludeCountryCodes: z.array(z.string().length(2)).default([]),
});

export const SalesChannelsConditionValueSchema = z.object({
  channels: z.array(z.string()).min(1),
});

export const UrlParamConditionValueSchema = z.object({
  param: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  value: z.string().optional(),
  operator: z.string().optional(),
}).refine((value) => value.param || value.key, {
  message: "URL parameter name is required.",
});

export const SubscriptionConditionValueSchema = z.object({
  mode: z.enum(["any", "subscription_only", "one_time_only"]),
});

export function validateConditionValue(conditionType: string, value: unknown): z.SafeParseReturnType<unknown, unknown> {
  switch (conditionType) {
    case "cart_value":
    case "cart_value_multiplier":
      return CartValueConditionValueSchema.safeParse(value);
    case "cart_quantity":
      return CartQuantityConditionValueSchema.safeParse(value);
    case "specific_product":
      return SpecificProductConditionValueSchema.safeParse(value);
    case "pack_of_products":
      return PackConditionValueSchema.safeParse(value);
    case "customer_tags":
      return CustomerTagsConditionValueSchema.safeParse(value);
    case "order_history_total_spent":
    case "order_history_last_order_spent":
    case "order_history_total_orders":
      return OrderHistoryConditionValueSchema.safeParse(value);
    case "markets":
      return MarketConditionValueSchema.safeParse(value);
    case "customer_location":
      return CountryConditionValueSchema.safeParse(value);
    case "sales_channels":
      return SalesChannelsConditionValueSchema.safeParse(value);
    case "specific_link":
      return UrlParamConditionValueSchema.safeParse(value);
    case "subscription_product_type":
      return SubscriptionConditionValueSchema.safeParse(value);
    case "one_use_per_customer":
      return z.record(z.string(), z.unknown()).safeParse(value);
    default:
      return z.record(z.string(), z.unknown()).safeParse(value);
  }
}

export const RewardValueSchema = z.object({
  amount: z.number().nonnegative(),
  currencyCode: z.string().length(3).optional(),
  tiers: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const RewardTargetSchema = z.object({
  scope: z.string().optional(),
  variantId: z.string().optional(),
  variantIds: z.array(z.string()).optional(),
  productId: z.string().optional(),
  productIds: z.array(z.string()).optional(),
});

export function validateRewardPayload(
  rewardType: string,
  discountType: string,
  value: unknown,
  target: unknown,
): z.SafeParseReturnType<unknown, unknown> {
  const rewardTypeResult = RewardTypeSchema.safeParse(rewardType);
  if (!rewardTypeResult.success) return rewardTypeResult;
  const discountTypeResult = DiscountTypeSchema.safeParse(discountType);
  if (!discountTypeResult.success) return discountTypeResult;
  const valueResult = RewardValueSchema.safeParse(value);
  if (!valueResult.success) return valueResult;
  const targetResult = RewardTargetSchema.safeParse(target);
  if (!targetResult.success) return targetResult;
  if (rewardType === "product_gift") {
    const parsedTarget = targetResult.data as z.infer<typeof RewardTargetSchema>;
    if (!parsedTarget.variantId && !parsedTarget.variantIds?.length && !parsedTarget.productId && !parsedTarget.productIds?.length) {
      return z.never().safeParse(target);
    }
  }
  return z.unknown().safeParse({ rewardType, discountType, value, target });
}

/** Full offer condition config stored in DB / compiled to Function metafield. */
export const OfferConditionSchema = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
  scope: ConditionScopeSchema,
  conditionType: ConditionTypeSchema,
  operator: ConditionOperatorSchema,
  value: z.unknown(),
  sortOrder: z.number().int().nonnegative(),
  isEnabled: z.boolean(),
});
export type OfferCondition = z.infer<typeof OfferConditionSchema>;

/** Gift target — what the customer gets. */
export const GiftTargetSchema = z.object({
  variantId: z.string(),
  productId: z.string(),
  quantity: z.number().int().positive(),
  trackMode: z.enum(["product", "variant"]),
});
export type GiftTarget = z.infer<typeof GiftTargetSchema>;

/** Reward config stored in DB. */
export const OfferRewardSchema = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
  rewardType: RewardTypeSchema,
  discountType: DiscountTypeSchema,
  value: z.unknown(),
  target: z.unknown(),
  quantity: z.number().int().positive().nullable(),
  isAutoAdd: z.boolean(),
  isCustomerSelectable: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  label: z.string().nullable(),
});
export type OfferReward = z.infer<typeof OfferRewardSchema>;

/** Compiled offer — minimal config pushed to Shopify Function metafield. */
export const CompiledOfferSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  type: OfferTypeSchema,
  priority: z.number().int(),
  stopLowerPriority: z.boolean(),
  /** Product/variant ID sets precompiled for fast lookup. */
  requiredProductIds: z.array(z.string()),
  requiredVariantIds: z.array(z.string()),
  excludedProductIds: z.array(z.string()),
  giftVariantIds: z.array(z.string()),
  giftProductIds: z.array(z.string()),
  /** Threshold in store currency cents. */
  cartValueThresholdCents: z.number().int().nonnegative().optional(),
  cartQuantityThreshold: z.number().int().nonnegative().optional(),
  maxGiftQuantity: z.number().int().positive().optional(),
  discountType: DiscountTypeSchema,
  discountValue: z.number().nonnegative(),
  currencyCode: z.string().length(3),
  combinesWithOrderDiscounts: z.boolean(),
  combinesWithShippingDiscounts: z.boolean(),
  combinesWithProductDiscounts: z.boolean(),
});
export type CompiledOffer = z.infer<typeof CompiledOfferSchema>;
