import { z } from "zod";

export const OfferTypeSchema = z.enum(["gift", "bundle", "upsell", "discount", "booster"]);
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
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "all",
  "any",
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
  "page_url",
  "line_attribute",
  "cart_attribute",
  "discount_code",
  "utm_parameters",
  "page_types",
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

export const SpecificProductRequirementSchema = z
  .object({
    productId: z.string().optional(),
    variantId: z.string().optional(),
    trackMode: TrackModeSchema.default("variant"),
    minQuantity: z.number().int().positive().default(1),
    maxQuantity: z.number().int().positive().optional(),
  })
  .refine((value) => value.productId || value.variantId, {
    message: "A product or variant id is required.",
  });

export const CartValueConditionValueSchema = z.object({
  thresholdCents: z.number().int().nonnegative(),
  maxCents: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).default("USD"),
  currencyOverrides: z.record(z.string(), z.number().int().nonnegative()).optional(),
  maxCurrencyOverrides: z.record(z.string(), z.number().int().nonnegative()).optional(),
  includeGiftValues: z.boolean().default(false),
  appliesTo: z.string().optional(),
  scopeFilter: z.record(z.string(), z.array(z.string())).optional(),
});

export const CartQuantityConditionValueSchema = z
  .object({
    minQuantity: z.number().int().positive(),
    maxQuantity: z.number().int().positive().optional(),
    includeGiftValues: z.boolean().default(false),
    appliesTo: z.string().optional(),
  })
  .refine((value) => value.maxQuantity === undefined || value.maxQuantity >= value.minQuantity, {
    message: "Maximum quantity must be greater than or equal to minimum quantity.",
  });

export const SpecificProductConditionValueSchema = z.object({
  requirements: z.array(SpecificProductRequirementSchema).min(1),
  multiplyByGroups: z.boolean().default(false),
});

export const PackConditionValueSchema = z.object({
  requirements: z
    .array(
      z
        .object({
          productId: z.string().optional(),
          variantId: z.string().optional(),
          trackMode: TrackModeSchema.default("variant"),
          quantityPerPack: z.number().int().positive(),
        })
        .refine((value) => value.productId || value.variantId, {
          message: "A product or variant id is required.",
        }),
    )
    .min(1),
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

export const MarketConditionValueSchema = z
  .object({
    includeMarketIds: z.array(z.string().min(1)).default([]),
    excludeMarketIds: z.array(z.string().min(1)).default([]),
  })
  .superRefine((value, context) => {
    if (value.includeMarketIds.length === 0 && value.excludeMarketIds.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Select at least one Market." });
    }
    const included = new Set(value.includeMarketIds);
    for (const id of value.excludeMarketIds) {
      if (included.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Market ${id} cannot be both included and excluded.`,
        });
      }
    }
  });

export const CountryConditionValueSchema = z.object({
  includeCountryCodes: z.array(z.string().length(2)).default([]),
  excludeCountryCodes: z.array(z.string().length(2)).default([]),
});

export const SalesChannelsConditionValueSchema = z.object({
  channels: z.array(z.string()).min(1),
});

const CanonicalUrlParamConditionValueSchema = z
  .object({
    requiredUrl: z.string().default(""),
    paramName: z.string().min(1).optional(),
    paramValue: z.string().optional(),
    onlyMatchedLines: z.boolean().optional(),
    rejectUnmatchedLines: z.boolean().optional(),
  })
  .refine((value) => value.requiredUrl.trim().length > 0 || Boolean(value.paramName), {
    message: "A required URL or URL parameter name is required.",
  });

export const UrlParamConditionValueSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if ("requiredUrl" in value || "paramName" in value) return value;
  return {
    requiredUrl: "",
    paramName: value["param"] ?? value["key"],
    paramValue: value["value"],
  };
}, CanonicalUrlParamConditionValueSchema);

export const SubscriptionConditionValueSchema = z.object({
  mode: z.enum(["any", "subscription_only", "one_time_only"]),
});

export const PageUrlConditionValueSchema = z.object({
  patterns: z
    .array(z.string().min(1, "Pattern cannot be empty"))
    .min(1, "At least one URL pattern is required"),
  matchMode: z.enum(["exact", "contains", "starts_with", "ends_with"]),
  caseSensitive: z.boolean().default(false),
  onlyMatchedLines: z.boolean().optional(),
  rejectUnmatchedLines: z.boolean().optional(),
});
export type PageUrlConditionValue = z.infer<typeof PageUrlConditionValueSchema>;

/** Storefront page kinds, classified from the pathname a cart line was added
 * from (locale prefix like /en or /fr-ca ignored). Mirrored by
 * `classifyPageType` in the rule engine and `page_type` in the Rust Function. */
export const PAGE_TYPES = ["home", "collection", "product", "search", "page", "blog", "cart"] as const;
export const PageTypeSchema = z.enum(PAGE_TYPES);
export type PageType = (typeof PAGE_TYPES)[number];

export const PageTypesConditionValueSchema = z.object({
  pageTypes: z.array(PageTypeSchema).min(1, "Select at least one page type."),
  onlyMatchedLines: z.boolean().optional(),
  rejectUnmatchedLines: z.boolean().optional(),
});
export type PageTypesConditionValue = z.infer<typeof PageTypesConditionValueSchema>;

/**
 * `onlyMatchedLines` on a page-matching condition (page_url / page_types /
 * utm_parameters / specific_link): discount only the cart lines added while on
 * the matching page. Unset means "the default", which is on for code promos
 * (offers with their own discount codes) and off for everything else.
 */
export function resolveOnlyMatchedLines(
  onlyMatchedLines: unknown,
  isCodePromo: boolean,
): boolean {
  return typeof onlyMatchedLines === "boolean" ? onlyMatchedLines : isCodePromo;
}

/**
 * `rejectUnmatchedLines` on a page-matching condition: the offer does not
 * apply at all while any non-gift cart line was added from a non-matching
 * page. Off unless explicitly set, for code promos too.
 */
export function resolveRejectUnmatchedLines(rejectUnmatchedLines: unknown): boolean {
  return rejectUnmatchedLines === true;
}

export const LINE_ATTRIBUTE_KEYS = [
  "__landing_source",
  "__bundle_type",
  "__cart_gift_tier",
  "_bundle_item",
  "_nektar_glp1",
  "_quiz_bundle_id",
  "_quiz_target_cents",
  "_quiz_expected_paid_count",
  "_quiz_free_gift",
] as const;
export const AttributeKeySchema = z
  .string()
  .trim()
  .min(1, "Attribute key is required.")
  .max(100, "Attribute key must be 100 characters or fewer.")
  .refine(
    (key) => !/[\u0000-\u001f\u007f]/u.test(key),
    "Attribute key cannot contain control characters.",
  );
export const LineAttributeKeySchema = AttributeKeySchema;
export const CART_ATTRIBUTE_KEYS = ["source"] as const;
export const CartAttributeKeySchema = AttributeKeySchema;
export const LineAttributeConditionValueSchema = z.object({
  key: LineAttributeKeySchema,
  value: z.string().min(1).max(255),
  matchMode: z.enum(["equals", "not_equals"]).default("equals"),
  minMatchingQuantity: z.number().int().positive().default(1),
});
export const CartAttributeConditionValueSchema = z
  .object({
    key: CartAttributeKeySchema,
    value: z.string().min(1).max(255).optional(),
    matchMode: z.enum(["equals", "not_equals", "exists"]).default("equals"),
  })
  .refine((value) => value.matchMode === "exists" || value.value !== undefined, {
    message: "A value is required unless matchMode is 'exists'.",
    path: ["value"],
  });

/** Gates an offer on a specific discount code being entered and Shopify-accepted
 * on the cart (`cart.discountCodes`). Matching is case-insensitive, mirroring
 * Shopify's own case-insensitive code lookup. */
export const DiscountCodeConditionValueSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A discount code is required.")
    .max(255, "Discount code must be 255 characters or fewer."),
});
export type DiscountCodeConditionValue = z.infer<typeof DiscountCodeConditionValueSchema>;

/** Validates `offers.requiredDiscountCode` — the checkout code that gates a
 * genuine Shopify code-based app discount for the offer (distinct from the
 * `discount_code` condition type above, which gates an *automatic* offer on
 * a code already present in `cart.discountCodes`). Normalizes the same way
 * it's stored: trimmed and uppercased, so lookups/comparisons are
 * case-insensitive without relying on every caller doing it consistently. */
export const RequiredDiscountCodeSchema = z
  .string()
  .trim()
  .min(1, "A discount code is required.")
  .max(255, "Discount code must be 255 characters or fewer.")
  .transform((code) => code.toUpperCase());
export type RequiredDiscountCode = z.infer<typeof RequiredDiscountCodeSchema>;

export function validateRequiredDiscountCode(
  code: unknown,
): z.SafeParseReturnType<unknown, string> {
  return RequiredDiscountCodeSchema.safeParse(code);
}

/** Gates an offer on UTM parameters captured from the customer's original
 * landing URL (auto-stamped as `_promo_page_url` by the storefront runtime —
 * see `packages/storefront-runtime/src/metadata-bridge.ts` — no landing-page
 * snippet required, unlike the `__landing_source` line-attribute mechanism).
 * With `scope: "visit"` the params are read from `_promo_landing_url` instead:
 * the session's most recent page view that carried any utm_* param.
 * Compiles to one `pageUrlConditions` entry per filled-in field, all AND'd
 * together by the Function. At least one field must be set. */
export const UtmParametersConditionValueSchema = z
  .object({
    utmSource: z.string().trim().max(255, "UTM source must be 255 characters or fewer.").optional(),
    utmMedium: z.string().trim().max(255, "UTM medium must be 255 characters or fewer.").optional(),
    utmCampaign: z
      .string()
      .trim()
      .max(255, "UTM campaign must be 255 characters or fewer.")
      .optional(),
    utmTerm: z.string().trim().max(255, "UTM term must be 255 characters or fewer.").optional(),
    utmContent: z.string().trim().max(255, "UTM content must be 255 characters or fewer.").optional(),
    /** "page" (default): the page the line was added from; "visit": the session's last UTM landing URL. */
    scope: z.enum(["page", "visit"]).optional(),
    onlyMatchedLines: z.boolean().optional(),
    rejectUnmatchedLines: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.utmSource || value.utmMedium || value.utmCampaign || value.utmTerm || value.utmContent,
      ),
    { message: "Enter at least one UTM parameter to match." },
  );
export type UtmParametersConditionValue = z.infer<typeof UtmParametersConditionValueSchema>;

/**
 * Per-condition-type Zod schema, keyed by `ConditionType`. This is the
 * type-level counterpart to `validateConditionValue`'s runtime dispatch
 * below — previously the mapping from `conditionType` string to its
 * value's actual shape existed only in that switch statement, so a field
 * rename in one of these schemas would compile cleanly everywhere a
 * consumer read `value as Record<string, unknown>` and only fail silently
 * at runtime.
 *
 * Condition types that have never had a dedicated schema (they've always
 * validated against the generic `z.record(...)` fallback in
 * `validateConditionValue`) map to that same catch-all here, so
 * `ConditionValueByType` for them stays `Record<string, unknown>` — exactly
 * as loose as before. Giving one of these a real schema is a separate,
 * follow-up change: it would tighten runtime validation, which this map
 * intentionally does not do.
 */
const GENERIC_CONDITION_VALUE_SCHEMA = z.record(z.string(), z.unknown());

export const CONDITION_VALUE_SCHEMAS = {
  cart_value: CartValueConditionValueSchema,
  cart_value_multiplier: CartValueConditionValueSchema,
  cart_quantity: CartQuantityConditionValueSchema,
  specific_product: SpecificProductConditionValueSchema,
  pack_of_products: PackConditionValueSchema,
  specific_link: UrlParamConditionValueSchema,
  order_history_total_spent: OrderHistoryConditionValueSchema,
  order_history_last_order_spent: OrderHistoryConditionValueSchema,
  order_history_total_orders: OrderHistoryConditionValueSchema,
  one_use_per_customer: GENERIC_CONDITION_VALUE_SCHEMA,
  customer_tags: CustomerTagsConditionValueSchema,
  customer_location: CountryConditionValueSchema,
  markets: MarketConditionValueSchema,
  subscription_product_type: SubscriptionConditionValueSchema,
  sales_channels: SalesChannelsConditionValueSchema,
  product_quantity_limits: GENERIC_CONDITION_VALUE_SCHEMA,
  collection_quantity_limits: GENERIC_CONDITION_VALUE_SCHEMA,
  vendor_quantity_limits: GENERIC_CONDITION_VALUE_SCHEMA,
  product_type_quantity_limits: GENERIC_CONDITION_VALUE_SCHEMA,
  exclude_products: GENERIC_CONDITION_VALUE_SCHEMA,
  exclude_collections: GENERIC_CONDITION_VALUE_SCHEMA,
  exclude_vendors: GENERIC_CONDITION_VALUE_SCHEMA,
  exclude_types: GENERIC_CONDITION_VALUE_SCHEMA,
  page_url: PageUrlConditionValueSchema,
  line_attribute: LineAttributeConditionValueSchema,
  cart_attribute: CartAttributeConditionValueSchema,
  discount_code: DiscountCodeConditionValueSchema,
  utm_parameters: UtmParametersConditionValueSchema,
  page_types: PageTypesConditionValueSchema,
} satisfies Record<ConditionType, z.ZodTypeAny>;

/** Value shape for each condition type, derived from `CONDITION_VALUE_SCHEMAS`. */
export type ConditionValueByType = {
  [K in ConditionType]: z.infer<(typeof CONDITION_VALUE_SCHEMAS)[K]>;
};

/**
 * A condition's `conditionType` tagged together with its properly-typed
 * `value` — a true discriminated union. Switching on `.conditionType` lets
 * TypeScript narrow `.value` to the matching schema's inferred type in each
 * branch, instead of consumers re-casting `value as Record<string,
 * unknown>` and indexing it with string keys.
 */
export type TypedOfferCondition = {
  [K in ConditionType]: { conditionType: K; value: ConditionValueByType[K] };
}[ConditionType];

export function validateConditionValue(
  conditionType: string,
  value: unknown,
): z.SafeParseReturnType<unknown, unknown> {
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
    case "page_url":
      return PageUrlConditionValueSchema.safeParse(value);
    case "line_attribute":
      return LineAttributeConditionValueSchema.safeParse(value);
    case "cart_attribute":
      return CartAttributeConditionValueSchema.safeParse(value);
    case "discount_code":
      return DiscountCodeConditionValueSchema.safeParse(value);
    case "utm_parameters":
      return UtmParametersConditionValueSchema.safeParse(value);
    case "page_types":
      return PageTypesConditionValueSchema.safeParse(value);
    case "one_use_per_customer":
      return z.record(z.string(), z.unknown()).safeParse(value);
    default:
      return z.record(z.string(), z.unknown()).safeParse(value);
  }
}

export const RewardValueSchema = z
  .object({
    amount: z.number().nonnegative(),
    currencyCode: z.string().length(3).optional(),
    tiers: z.array(z.record(z.string(), z.unknown())).optional(),
    currencyOverrides: z.record(z.string(), z.number().nonnegative()).optional(),
    fixedAmountOverrides: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .strict();

export const RewardTargetSchema = z.object({
  scope: z.string().optional(),
  variantId: z.string().optional(),
  variantIds: z.array(z.string()).optional(),
  fallbackVariantIds: z.array(z.string()).optional(),
  productId: z.string().optional(),
  productIds: z.array(z.string()).optional(),
  lineQuantityEquals: z.number().int().positive().optional(),
  maxUnitsTotal: z.number().int().positive().optional(),
  maxUnitsPerProduct: z.number().int().positive().optional(),
  maxUnitsPerLine: z.number().int().positive().optional(),
  maxUnitsPerVariant: z.number().int().positive().optional(),
  subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]).optional(),
  scopeMode: z.enum(["sitewide", "landing", "quiz_bundle", "tagged_offer"]).optional(),
  requiredOfferId: z.string().uuid().optional(),
  requiredLineAttributeKey: z.literal("__landing_source").optional(),
  requiredLineAttributeValue: z.string().min(1).optional(),
  requiredAnchorVariantIds: z.array(z.string().min(1)).optional(),
  requiredAnchorMinQuantity: z.number().int().positive().optional(),
  requiresAnchorSubscription: z.boolean().optional(),
  priceTiers: z
    .array(
      z.object({
        quantity: z.number().int().positive(),
        targetPricePerUnit: z.number().nonnegative(),
      }),
    )
    .min(1)
    .optional(),
  discountPercentageOnGifts: z.number().min(0).max(100).optional(),
});

const ShopifyProductGidSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/Product\/\d+$/, "Expected a Shopify Product GID.");
const ShopifyVariantGidSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "Expected a Shopify ProductVariant GID.");

export const ProductGiftTargetSchema = z
  .object({
    scope: z.literal("cart").optional(),
    variantId: ShopifyVariantGidSchema.optional(),
    variantIds: z.array(ShopifyVariantGidSchema).min(1).optional(),
    /** Ordered replacements used only while every primary gift variant is sold out. */
    fallbackVariantIds: z.array(ShopifyVariantGidSchema).max(5).optional(),
    productId: ShopifyProductGidSchema.optional(),
    productIds: z.array(ShopifyProductGidSchema).min(1).max(1).optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (
      !target.variantId &&
      !target.variantIds?.length &&
      !target.productId &&
      !target.productIds?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A gift product or variant target is required.",
      });
    }
    if (target.variantId && target.variantIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variantIds"],
        message: "Use variantId or variantIds, not both.",
      });
    }
    if (target.productId && target.productIds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productIds"],
        message: "Use productId or productIds, not both.",
      });
    }
  });

export const OrderDiscountTargetSchema = z
  .object({
    scope: z.literal("cart"),
  })
  .strict();

const RequiredLineAttributeSchema = z.object({
  key: LineAttributeKeySchema,
  value: z.string().min(1),
});

const ProductTargetIdsSchema = z.object({
  scope: z.enum(["cart", "all_products"]).optional(),
  variantId: z.string().optional(),
  variantIds: z.array(z.string()).optional(),
  productId: z.string().optional(),
  productIds: z.array(z.string()).optional(),
  lineQuantityEquals: z.number().int().positive().optional(),
  maxUnitsTotal: z.number().int().positive().optional(),
  maxUnitsPerProduct: z.number().int().positive().optional(),
  maxUnitsPerLine: z.number().int().positive().optional(),
  maxUnitsPerVariant: z.number().int().positive().optional(),
  subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]).default("any"),
  selectionMode: z.enum(["all", "cheapest", "most_expensive"]).default("all"),
  countRule: z.enum(["all", "unique"]).default("all"),
  displayType: z.enum(["quantity_options", "discount_table"]).optional(),
  /** Only lines whose packed metadata carries this key/value qualify (e.g. __bundle_type). */
  requiredLineAttribute: RequiredLineAttributeSchema.optional(),
});

// Rewards unlocked by a client-set line attribute (quiz bundle id / offer id)
// must name the products they apply to — publish rejects them otherwise.
const TAGGED_REWARD_ALLOWLIST = {
  productId: z.string().optional(),
  productIds: z.array(z.string()).optional(),
  variantId: z.string().optional(),
  variantIds: z.array(z.string()).optional(),
};

export const ProductDiscountTargetSchema = z.discriminatedUnion("scopeMode", [
  ProductTargetIdsSchema.extend({
    scopeMode: z.literal("sitewide"),
  }).strict(),
  ProductTargetIdsSchema.extend({
    scopeMode: z.literal("landing"),
    requiredLineAttributeKey: z.literal("__landing_source"),
    requiredLineAttributeValue: z.string().min(1),
    requiredAnchorVariantIds: z.array(z.string().min(1)).default([]),
    requiredAnchorMinQuantity: z.number().int().positive().default(1),
    requiresAnchorSubscription: z.boolean().default(false),
    priceTiers: z
      .array(
        z
          .object({
            quantity: z.number().int().positive(),
            targetPricePerUnit: z.number().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
  }).strict(),
  ProductTargetIdsSchema.extend({
    scopeMode: z.literal("tagged_offer"),
    requiredOfferId: z.string().uuid(),
    ...TAGGED_REWARD_ALLOWLIST,
  }).strict(),
  z
    .object({
      scopeMode: z.literal("quiz_bundle"),
      scope: z.literal("cart").default("cart"),
      discountPercentageOnGifts: z.number().min(0).max(100).default(100),
      ...TAGGED_REWARD_ALLOWLIST,
    })
    .strict(),
]);

export const ShippingTierAppliesWhenSchema = z.enum(["has_subscription", "one_time_only"]);
export type ShippingTierAppliesWhen = z.infer<typeof ShippingTierAppliesWhenSchema>;

export const DeliveryGroupTypeSchema = z.enum(["ONE_TIME_PURCHASE", "SUBSCRIPTION"]);
export type DeliveryGroupType = z.infer<typeof DeliveryGroupTypeSchema>;

const boundedTier = <T extends z.ZodRawShape>(
  shape: T,
  minimumKey: keyof z.infer<z.ZodObject<T>> & string,
  maximumKey: keyof z.infer<z.ZodObject<T>> & string,
) =>
  z
    .object(shape)
    .strict()
    .superRefine((tier, ctx) => {
      const minimum = tier[minimumKey] as number;
      const maximum = tier[maximumKey] as number | undefined;
      if (maximum !== undefined && maximum < minimum) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [maximumKey],
          message: "Maximum tier bound must be greater than or equal to its minimum.",
        });
      }
    });

export const ProductDiscountTierSchema = boundedTier(
  {
    minimumQuantity: z.number().int().positive(),
    maximumQuantity: z.number().int().positive().optional(),
    discountType: z.enum(["percentage", "fixed_amount", "fixed_price", "free"]),
    discountValue: z.number().nonnegative(),
    discountedQuantity: z.number().int().positive().optional(),
    label: z.string().max(120).optional(),
  },
  "minimumQuantity",
  "maximumQuantity",
).superRefine((tier, ctx) => {
  if (tier.discountType === "percentage" && tier.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Discount percentage cannot exceed 100%.",
    });
  }
});
export type ProductDiscountTier = z.infer<typeof ProductDiscountTierSchema>;

export const SubtotalDiscountTierSchema = boundedTier(
  {
    minimumSubtotalCents: z.number().int().nonnegative(),
    maximumSubtotalCents: z.number().int().nonnegative().optional(),
    discountType: z.enum(["percentage", "fixed_amount", "free"]),
    discountValue: z.number().nonnegative(),
    label: z.string().max(120).optional(),
  },
  "minimumSubtotalCents",
  "maximumSubtotalCents",
).superRefine((tier, ctx) => {
  if (tier.discountType === "percentage" && tier.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Discount percentage cannot exceed 100%.",
    });
  }
});
export type SubtotalDiscountTier = z.infer<typeof SubtotalDiscountTierSchema>;

export const QuantityDiscountTierSchema = boundedTier(
  {
    minimumQuantity: z.number().int().positive(),
    maximumQuantity: z.number().int().positive().optional(),
    discountType: z.enum(["percentage", "fixed_amount", "free"]),
    discountValue: z.number().nonnegative(),
    label: z.string().max(120).optional(),
  },
  "minimumQuantity",
  "maximumQuantity",
).superRefine((tier, ctx) => {
  if (tier.discountType === "percentage" && tier.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Discount percentage cannot exceed 100%.",
    });
  }
});
export type QuantityDiscountTier = z.infer<typeof QuantityDiscountTierSchema>;
export const OrderDiscountTierSchema = z.union([
  SubtotalDiscountTierSchema,
  QuantityDiscountTierSchema,
]);

export const ShippingDiscountTierSchema = z
  .object({
    minimumSubtotalCents: z.number().int().nonnegative(),
    maximumSubtotalCents: z.number().int().nonnegative().optional(),
    discountType: z.enum(["percentage", "fixed_amount"]),
    // 0 is valid: a 0% tier that's the highest qualifying one means "no
    // discount for this bracket" without falling through to a lower tier.
    discountValue: z.number().nonnegative(),
    appliesWhen: ShippingTierAppliesWhenSchema.optional(),
  })
  .strict()
  .superRefine((tier, ctx) => {
    if (
      tier.maximumSubtotalCents !== undefined &&
      tier.maximumSubtotalCents < tier.minimumSubtotalCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumSubtotalCents"],
        message: "Maximum subtotal must be greater than or equal to minimum subtotal.",
      });
    }
    if (tier.discountType === "percentage" && tier.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Shipping discount percentage cannot exceed 100%.",
      });
    }
  });
export type ShippingDiscountTier = z.infer<typeof ShippingDiscountTierSchema>;

export const ShippingDiscountRewardValueSchema = z
  .object({
    amount: z.number().nonnegative().optional(),
    currencyCode: z.string().length(3).default("USD"),
    tiers: z.array(ShippingDiscountTierSchema).min(1).optional(),
  })
  .strict()
  .refine((value) => value.amount !== undefined || Boolean(value.tiers?.length), {
    message: "Configure at least one shipping discount tier.",
  });

export const ShippingDiscountRewardTargetSchema = z
  .object({
    deliveryGroupTypes: z.array(DeliveryGroupTypeSchema).min(1),
    scopeMode: z.enum(["sitewide", "landing", "quiz_bundle"]).default("sitewide"),
    requiredLineAttributeKey: z.literal("__landing_source").optional(),
    requiredLineAttributeValue: z.string().min(1).optional(),
    requiredAnchorVariantIds: z.array(z.string().min(1)).optional(),
    requiredAnchorMinQuantity: z.number().int().positive().optional(),
    requiresAnchorSubscription: z.boolean().optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (target.scopeMode !== "landing") return;
    if (target.requiredLineAttributeKey !== "__landing_source") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredLineAttributeKey"],
        message: "Landing shipping rules must use the __landing_source line property.",
      });
    }
    if (!target.requiredLineAttributeValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredLineAttributeValue"],
        message: "Landing source value is required.",
      });
    }
  });

export const ShippingDiscountRewardPayloadSchema = z
  .object({
    discountType: z.enum(["percentage", "fixed_amount", "free"]),
    value: ShippingDiscountRewardValueSchema,
    target: ShippingDiscountRewardTargetSchema,
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (
      payload.discountType === "percentage" &&
      payload.value.amount !== undefined &&
      payload.value.amount > 100
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value", "amount"],
        message: "Shipping discount percentage cannot exceed 100%.",
      });
    }
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
  if (rewardType === "shipping_discount") {
    return ShippingDiscountRewardPayloadSchema.safeParse({
      discountType,
      value,
      target,
    });
  }
  if (
    rewardType === "order_discount" &&
    discountType !== "percentage" &&
    discountType !== "fixed_amount" &&
    discountType !== "free"
  ) {
    return z.never().safeParse(discountType);
  }
  if (
    rewardType === "product_gift" &&
    discountType !== "percentage" &&
    discountType !== "fixed_amount" &&
    discountType !== "free"
  ) {
    return z.never().safeParse(discountType);
  }
  const valueResult = RewardValueSchema.safeParse(value);
  if (!valueResult.success) return valueResult;
  if (valueResult.data.tiers?.length && isProductDiscountRewardType(rewardType)) {
    const tiersResult = z.array(ProductDiscountTierSchema).min(1).safeParse(valueResult.data.tiers);
    if (!tiersResult.success) return tiersResult;
  }
  if (valueResult.data.tiers?.length && rewardType === "order_discount") {
    const tiersResult = z.array(OrderDiscountTierSchema).min(1).safeParse(valueResult.data.tiers);
    if (!tiersResult.success) return tiersResult;
  }
  if (discountType === "percentage" && valueResult.data.amount > 100) {
    return z.number().max(100).safeParse(valueResult.data.amount);
  }
  const targetRecord =
    typeof target === "object" && target !== null ? (target as Record<string, unknown>) : {};
  const isProductDiscountReward = isProductDiscountRewardType(rewardType);
  const targetResult = isProductDiscountReward
    ? ProductDiscountTargetSchema.safeParse({ scopeMode: "sitewide", ...targetRecord })
    : rewardType === "product_gift"
      ? ProductGiftTargetSchema.safeParse(target)
      : rewardType === "order_discount"
        ? OrderDiscountTargetSchema.safeParse(target)
        : RewardTargetSchema.safeParse(target);
  if (!targetResult.success) return targetResult;
  if (rewardType === "product_gift") {
    return z.unknown().safeParse({ rewardType, discountType, value, target });
  }
  if (isProductDiscountReward) {
    const parsedTarget = targetResult.data as z.infer<typeof ProductDiscountTargetSchema>;
    const explicitlyTargetsCart =
      parsedTarget.scope === "cart" || parsedTarget.scope === "all_products";
    if (
      parsedTarget.scopeMode !== "quiz_bundle" &&
      !explicitlyTargetsCart &&
      !parsedTarget.variantId &&
      !parsedTarget.variantIds?.length &&
      !parsedTarget.productId &&
      !parsedTarget.productIds?.length
    ) {
      return z.never().safeParse(target);
    }
  }
  return z.unknown().safeParse({ rewardType, discountType, value, target });
}

function isProductDiscountRewardType(rewardType: string): boolean {
  return (
    rewardType === "product_discount" ||
    rewardType === "bundle_discount" ||
    rewardType === "upsell_discount"
  );
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
  /** Any-of trigger products/variants: qualifies if at least one is present in the cart. */
  anyRequiredProductIds: z.array(z.string()).default([]),
  anyRequiredVariantIds: z.array(z.string()).default([]),
  excludedProductIds: z.array(z.string()),
  giftVariantIds: z.array(z.string()),
  giftProductIds: z.array(z.string()),
  /** Threshold in store currency cents. */
  cartValueThresholdCents: z.number().int().nonnegative().optional(),
  cartValueMaxCents: z.number().int().nonnegative().optional(),
  currencyOverrides: z.record(z.string(), z.number().int().nonnegative()).optional(),
  maxCurrencyOverrides: z.record(z.string(), z.number().int().nonnegative()).optional(),
  cartQuantityThreshold: z.number().int().nonnegative().optional(),
  cartQuantityMax: z.number().int().nonnegative().optional(),
  subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]).optional(),
  maxGiftQuantity: z.number().int().positive().optional(),
  discountType: DiscountTypeSchema,
  discountValue: z.number().nonnegative(),
  currencyCode: z.string().length(3),
  combinesWithOrderDiscounts: z.boolean(),
  combinesWithShippingDiscounts: z.boolean(),
  combinesWithProductDiscounts: z.boolean(),
  requirements: z
    .array(
      z.object({
        productId: z.string().optional(),
        variantId: z.string().optional(),
        trackMode: TrackModeSchema,
        minQuantity: z.number().int().positive(),
        maxQuantity: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  giftRewards: z
    .array(
      z.object({
        id: z.string().uuid(),
        targetProductIds: z.array(z.string()),
        targetVariantIds: z.array(z.string()),
        discountType: DiscountTypeSchema,
        discountValue: z.number().nonnegative(),
        maxQuantity: z.number().int().positive(),
      }),
    )
    .default([]),
  productRewards: z
    .array(
      z.object({
        id: z.string(),
        rewardType: RewardTypeSchema,
        targetProductIds: z.array(z.string()),
        targetVariantIds: z.array(z.string()),
        discountType: DiscountTypeSchema,
        discountValue: z.number().nonnegative(),
        maxQuantity: z.number().int().positive().optional(),
        lineQuantityEquals: z.number().int().positive().optional(),
        maxUnitsTotal: z.number().int().positive().optional(),
        maxUnitsPerProduct: z.number().int().positive().optional(),
        subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]),
        scopeMode: z
          .enum(["sitewide", "landing", "quiz_bundle", "tagged_offer"])
          .default("sitewide"),
        requiredOfferId: z.string().uuid().optional(),
        requiredLineAttributeValue: z.string().optional(),
        requiredAnchorVariantIds: z.array(z.string()).default([]),
        requiredAnchorMinQuantity: z.number().int().positive().default(1),
        requiresAnchorSubscription: z.boolean().default(false),
        priceTiers: z
          .array(
            z.object({
              quantity: z.number().int().positive(),
              targetPricePerUnit: z.number().nonnegative(),
            }),
          )
          .default([]),
        quantityTiers: z.array(ProductDiscountTierSchema).default([]),
        selectionMode: z.enum(["all", "cheapest", "most_expensive"]).default("all"),
        countRule: z.enum(["all", "unique"]).default("all"),
        discountPercentageOnGifts: z.number().min(0).max(100).default(100),
        requiredLineAttribute: RequiredLineAttributeSchema.optional(),
      }),
    )
    .default([]),
  orderRewards: z
    .array(
      z.object({
        id: z.string(),
        discountType: z.enum(["percentage", "fixed_amount", "free"]),
        discountValue: z.number().nonnegative(),
        subtotalTiers: z.array(OrderDiscountTierSchema).default([]),
      }),
    )
    .default([]),
  lineAttributeConditions: z
    .array(
      z.object({
        key: LineAttributeKeySchema,
        value: z.string().min(1),
        matchMode: z.enum(["equals", "not_equals"]),
        minMatchingQuantity: z.number().int().positive(),
      }),
    )
    .default([]),
  cartAttributeConditions: z
    .array(
      z.object({
        key: CartAttributeKeySchema,
        value: z.string().min(1).optional(),
        matchMode: z.enum(["equals", "not_equals", "exists"]),
        minMatchingQuantity: z.number().int().positive(),
      }),
    )
    .default([]),
  pageUrlConditions: z
    .array(
      z.object({
        patterns: z.array(z.string()),
        matchMode: z.enum(["exact", "contains", "starts_with", "ends_with", "page_type"]),
        caseSensitive: z.boolean(),
        paramName: z.string().optional(),
        paramValue: z.string().optional(),
        source: z.literal("landing").optional(),
      }),
    )
    .default([]),
});
export type CompiledOffer = z.infer<typeof CompiledOfferSchema>;
