import { z } from "zod";

/** Normalized cart line — abstraction over Ajax Cart API and Storefront API. */
export const NormalizedCartLineSchema = z.object({
  /** Line key from Ajax Cart API, or Storefront API cart line ID. */
  key: z.string().min(1).max(512),
  variantId: z.string().min(1).max(128),
  productId: z.string().min(1).max(128),
  quantity: z.number().int().positive().max(2_000),
  /** Price in store currency cents. */
  priceCents: z.number().int().nonnegative(),
  /** Final line subtotal after line-level discounts, in store currency cents. */
  lineSubtotalCents: z.number().int().nonnegative().optional(),
  compareAtPriceCents: z.number().int().nonnegative().nullable(),
  /** All line item properties / attributes. */
  properties: z.record(z.string().max(128), z.string().max(2_048)).superRefine((properties, ctx) => {
    if (Object.keys(properties).length > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Cart lines cannot contain more than 100 properties." });
    }
  }),
  requiresSellingPlan: z.boolean(),
  sellingPlanId: z.string().nullable(),
  productHandle: z.string().max(255),
  productTitle: z.string().max(1_000),
  variantTitle: z.string().max(1_000).nullable(),
  vendor: z.string().max(255),
  productType: z.string().max(255),
  tags: z.array(z.string().max(255)).max(250),
  collections: z.array(z.string().max(128)).max(250),
  availableForSale: z.boolean(),
  inventoryPolicy: z.enum(["CONTINUE", "DENY"]),
  inventoryQuantity: z.number().int().nullable(),
});
export type NormalizedCartLine = z.infer<typeof NormalizedCartLineSchema>;

/** Line properties written by promo engine — used to identify and validate gift lines. */
export const PromoLinePropertiesSchema = z.object({
  _promo_engine_line_type: z.enum(["gift", "bundle_component", "upsell"]),
  _promo_engine_offer_id: z.string().uuid(),
  _promo_engine_offer_version: z.string(),
  _promo_engine_reward_id: z.string().uuid(),
});
export type PromoLineProperties = z.infer<typeof PromoLinePropertiesSchema>;

/** Normalized cart. */
export const NormalizedCartSchema = z.object({
  token: z.string().max(512).nullable(),
  id: z.string().max(512).nullable(),
  lines: z.array(NormalizedCartLineSchema).max(250),
  /** Cart-level attributes exposed by Shopify's Ajax Cart and Functions APIs. */
  attributes: z.record(z.string().max(128), z.string().max(2_048)).optional(),
  /** Subtotal in store currency cents (before discounts). */
  subtotalCents: z.number().int().nonnegative(),
  discountCodes: z.array(z.string().min(1).max(255)).max(100),
  currencyCode: z.string().length(3).regex(/^[A-Z]{3}$/),
  totalQuantity: z.number().int().nonnegative().max(500_000),
});
export type NormalizedCart = z.infer<typeof NormalizedCartSchema>;

/** Normalized customer (from Shopify session or Storefront API). */
export const NormalizedCustomerSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  tags: z.array(z.string()),
  totalSpentCents: z.number().int().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  lastOrderSpentCents: z.number().int().nonnegative().nullable(),
  countryCode: z.string().length(2).nullable(),
  isFirstTimeCustomer: z.boolean(),
});
export type NormalizedCustomer = z.infer<typeof NormalizedCustomerSchema>;

export const MarketContextSchema = z.object({
  // Storefront bundles cached before the GID fix send Liquid's numeric market id.
  id: z.preprocess(
    (value) => (typeof value === "number" ? `gid://shopify/Market/${value}` : value),
    z.string(),
  ),
  handle: z.string(),
  currencyCode: z.string().length(3),
  countryCode: z.string().length(2).nullable(),
  primaryLocale: z.string(),
  /** Exchange rate from shop base currency to this market's currency. Populated by storefront from window.Shopify.currency.rate. */
  exchangeRate: z.number().positive().nullable().optional(),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

export const SalesChannelSchema = z.enum(["online_store", "pos", "mobile_app", "headless"]);
export type SalesChannel = z.infer<typeof SalesChannelSchema>;

/** Full evaluation input contract. */
export const EvaluationInputSchema = z.object({
  shopDomain: z.string().min(1).max(255),
  cart: NormalizedCartSchema,
  customer: NormalizedCustomerSchema.nullable(),
  market: MarketContextSchema.nullable(),
  locale: z.string().max(35).nullable(),
  salesChannel: SalesChannelSchema,
  requestedUrl: z.string().url().nullable(),
  sessionId: z.string().min(1).max(128),
  /** `offerId:rewardId` pairs the customer explicitly declined (removed or
   * dismissed the slider without picking) — evaluator must not auto-add these. */
  declinedGiftRewards: z.array(z.string().max(256)).max(200).optional(),
});
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;
