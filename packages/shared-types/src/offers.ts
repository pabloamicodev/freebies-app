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
