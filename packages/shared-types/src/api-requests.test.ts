import { describe, expect, it } from "vitest";
import {
  AnalyticsRequestSchema,
  OrderAttributionQuerySchema,
  ProductSearchQuerySchema,
  ReportErrorRequestSchema,
  normalizeAnalyticsRequest,
} from "./api-requests.js";

describe("api request schemas", () => {
  it("report-error needs a non-blank message", () => {
    expect(ReportErrorRequestSchema.safeParse({ message: "  " }).success).toBe(false);
    expect(ReportErrorRequestSchema.safeParse({ message: "boom", stack: 1 }).success).toBe(false);
    expect(ReportErrorRequestSchema.safeParse({ message: "boom", url: "https://x.test/a" }).success).toBe(true);
  });

  it("analytics accepts a batch or a single event and rejects unknown names and big batches", () => {
    const one = AnalyticsRequestSchema.parse({ event: "promo_engine:gift_added", offer_id: "x" });
    expect(normalizeAnalyticsRequest(one)).toHaveLength(1);
    const batch = AnalyticsRequestSchema.parse({ events: [{ event: "page_viewed" }, { event_name: "cart_viewed" }] });
    expect(normalizeAnalyticsRequest(batch)).toHaveLength(2);
    expect(AnalyticsRequestSchema.safeParse({ event: "evil" }).success).toBe(false);
    expect(AnalyticsRequestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(
      AnalyticsRequestSchema.safeParse({ events: Array.from({ length: 21 }, () => ({ event: "page_viewed" })) }).success,
    ).toBe(false);
  });

  it("product search clamps limit and rejects mixed or malformed ids", () => {
    const parse = (value: Record<string, string | null>) =>
      ProductSearchQuerySchema.safeParse({ q: null, ids: null, limit: null, variants: null, ...value });
    expect(parse({ limit: "9999" })).toMatchObject({
      success: true,
      data: { limit: 200, q: "", ids: null, variants: false },
    });
    expect(parse({ ids: "gid://shopify/Product/1,gid://shopify/ProductVariant/2" }).success).toBe(false);
    expect(parse({ ids: "nope" }).success).toBe(false);
    expect(parse({ ids: "gid://shopify/Product/1" }).success).toBe(true);
  });

  it("order attribution requires an order gid", () => {
    expect(OrderAttributionQuerySchema.safeParse({ order_gid: null }).success).toBe(false);
    expect(OrderAttributionQuerySchema.safeParse({ order_gid: "gid://shopify/Order/5" }).success).toBe(true);
  });
});
