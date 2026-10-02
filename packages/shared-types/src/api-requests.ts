/**
 * Request-boundary schemas for the api.* and apps.promo-engine.* routes. The routes (WS-E/WS-F) wire these in;
 * each schema documents exactly what the route reads today, so adopting it never rejects a payload the
 * route accepts.
 *
 *  POST api.report-error                        -> ReportErrorRequestSchema
 *  POST apps.promo-engine.analytics             -> AnalyticsRequestSchema (+ normalizeAnalyticsRequest)
 *  POST apps.promo-engine.evaluate / api.checkout.evaluate -> EvaluationInputSchema (cart.ts; the route merges server fields)
 *  GET  api.products.search                     -> ProductSearchQuerySchema
 *  GET  api.products.search.collections         -> CollectionSearchQuerySchema
 *  GET  api.offers.$id.codes.export             -> CodesExportQuerySchema
 *  GET  api.customer-account.order-attribution
 *       and apps.promo-engine.customer.order-attribution -> OrderAttributionQuerySchema
 *  GET  apps.promo-engine.bundle                -> BundleQuerySchema
 *  GET  apps.promo-engine.product-customizations -> ProductCustomizationsQuerySchema
 * api.sync, api.products.sync, api.health and api.cron.* read no body or query.
 * Query schemas take `searchParamsObject(url.searchParams, [...names])`.
 */
import { z } from "zod";

export const ReportErrorRequestSchema = z.object({
  message: z.string().trim().min(1, "A non-empty error message is required.").max(16_384),
  stack: z.string().max(16_384).optional(),
  url: z.string().max(2_048).optional(),
});
export type ReportErrorRequest = z.infer<typeof ReportErrorRequestSchema>;

export const PUBLIC_ANALYTICS_EVENTS = [
  "page_viewed",
  "product_viewed",
  "cart_viewed",
  "checkout_started",
  "order_placed",
] as const;
const PROMO_ANALYTICS_EVENT = /^promo_engine:[a-z0-9][a-z0-9_:-]{0,79}$/;

export function analyticsEventName(event: Record<string, unknown>): string | null {
  const value = event["event"] ?? event["event_name"] ?? event["eventName"];
  return typeof value === "string" ? value : null;
}

export const AnalyticsEventSchema = z.record(z.string(), z.unknown()).refine(
  (event) => {
    const name = analyticsEventName(event);
    return (
      name !== null &&
      ((PUBLIC_ANALYTICS_EVENTS as readonly string[]).includes(name) || PROMO_ANALYTICS_EVENT.test(name))
    );
  },
  { message: "One or more analytics event names are not accepted." },
);

/** The web pixel sends `{ events: [...] }` (max 20); the storefront runtime sends one event object. */
export const AnalyticsRequestSchema = z.union([
  z
    .object({
      events: z
        .array(AnalyticsEventSchema)
        .min(1, "No events provided.")
        .max(20, "Too many events in one batch (max 20)."),
    })
    .passthrough(),
  AnalyticsEventSchema,
]);
export type AnalyticsRequest = z.infer<typeof AnalyticsRequestSchema>;

export function normalizeAnalyticsRequest(body: AnalyticsRequest): Array<Record<string, unknown>> {
  const events = (body as { events?: unknown }).events;
  return Array.isArray(events) ? (events as Array<Record<string, unknown>>) : [body as Record<string, unknown>];
}

const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const SHOPIFY_VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

const limitParam = (fallback: number, max: number) =>
  z
    .string()
    .nullish()
    .transform((raw) => {
      const parsed = Number.parseInt(raw ?? String(fallback), 10);
      return Math.max(1, Math.min(Number.isNaN(parsed) ? fallback : parsed, max));
    });

export const ProductSearchQuerySchema = z.object({
  q: z
    .string()
    .nullish()
    .transform((value) => (value ?? "").trim())
    .pipe(z.string().max(100, "Search query is too long.")),
  ids: z
    .string()
    .nullish()
    .transform((raw) => (raw ? [...new Set(raw.split(",").filter(Boolean))] : null))
    .pipe(
      z
        .array(z.string())
        .max(200)
        .refine(
          (ids) => ids.every((id) => SHOPIFY_PRODUCT_GID.test(id) || SHOPIFY_VARIANT_GID.test(id)),
          "Product identifiers are invalid.",
        )
        .refine(
          (ids) =>
            !(ids.some((id) => SHOPIFY_PRODUCT_GID.test(id)) && ids.some((id) => SHOPIFY_VARIANT_GID.test(id))),
          "Product and variant identifiers cannot be mixed.",
        )
        .nullable(),
    ),
  limit: limitParam(20, 200),
  variants: z
    .string()
    .nullish()
    .transform((value) => value === "true"),
});

export const CollectionSearchQuerySchema = z.object({
  q: z
    .string()
    .nullish()
    .transform((value) => (value ?? "").trim()),
  limit: limitParam(20, 50),
});

export const CodesExportQuerySchema = z.object({
  q: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  status: z
    .string()
    .nullish()
    .transform((value) => (["active", "disabled", "exhausted"] as const).find((status) => status === value)),
});

export const OrderAttributionQuerySchema = z.object({
  order_gid: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/, "order_gid must be an Order GID."),
});

export const BundleQuerySchema = z.object({
  offer_id: z.string().uuid().nullish(),
  page_url: z.string().max(2_048).nullish(),
});

export const ProductCustomizationsQuerySchema = z.object({
  offer_id: z.string().uuid(),
  variant_id: z.string().min(1).max(128),
});

/** Turn URLSearchParams into the plain `{ name: string | null }` object the query schemas expect. */
export function searchParamsObject(params: URLSearchParams, names: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(names.map((name) => [name, params.get(name)]));
}
