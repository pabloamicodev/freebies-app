import { z } from "zod";

/** Normalized cart line — abstraction over Ajax Cart API and Storefront API. */
export const NormalizedCartLineSchema = z.object({
  /** Line key from Ajax Cart API, or Storefront API cart line ID. */
  key: z.string(),
  variantId: z.string(),
  productId: z.string(),
  quantity: z.number().int().positive(),
  /** Price in store currency cents. */
  priceCents: z.number().int().nonnegative(),
  compareAtPriceCents: z.number().int().nonnegative().nullable(),
  /** All line item properties / attributes. */
  properties: z.record(z.string(), z.string()),
  requiresSellingPlan: z.boolean(),
  sellingPlanId: z.string().nullable(),
  productHandle: z.string(),
  productTitle: z.string(),
  variantTitle: z.string().nullable(),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  collections: z.array(z.string()),
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
  /** HMAC of (offerId + variantId + sessionId) — verified server-side. */
  _promo_engine_hash: z.string(),
});
export type PromoLineProperties = z.infer<typeof PromoLinePropertiesSchema>;

/** Normalized cart. */
export const NormalizedCartSchema = z.object({
  token: z.string().nullable(),
  id: z.string().nullable(),
  lines: z.array(NormalizedCartLineSchema),
  /** Subtotal in store currency cents (before discounts). */
  subtotalCents: z.number().int().nonnegative(),
  discountCodes: z.array(z.string()),
  currencyCode: z.string().length(3),
  totalQuantity: z.number().int().nonnegative(),
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
  id: z.string(),
  handle: z.string(),
  currencyCode: z.string().length(3),
  countryCode: z.string().length(2).nullable(),
  primaryLocale: z.string(),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

export const SalesChannelSchema = z.enum(["online_store", "pos", "mobile_app", "headless"]);
export type SalesChannel = z.infer<typeof SalesChannelSchema>;

/** Full evaluation input contract. */
export const EvaluationInputSchema = z.object({
  shopDomain: z.string(),
  cart: NormalizedCartSchema,
  customer: NormalizedCustomerSchema.nullable(),
  market: MarketContextSchema.nullable(),
  locale: z.string().nullable(),
  salesChannel: SalesChannelSchema,
  requestedUrl: z.string().url().nullable(),
  sessionId: z.string(),
});
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;
