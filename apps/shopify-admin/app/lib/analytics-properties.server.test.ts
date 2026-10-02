import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsProperties, sanitizeAnalyticsUrl } from "./analytics-properties.server.js";

describe("sanitizeAnalyticsUrl", () => {
  it("keeps path and utm_* only", () => {
    expect(sanitizeAnalyticsUrl("https://shop.com/products/a?email=a%40b.com&gclid=x&utm_source=Mail&utm_medium=cpc#frag")).toBe(
      "/products/a?utm_source=Mail&utm_medium=cpc",
    );
    expect(sanitizeAnalyticsUrl("/cart?_kx=abc")).toBe("/cart");
  });
  it("rejects non-strings and unparsable input", () => {
    expect(sanitizeAnalyticsUrl(42)).toBeNull();
    expect(sanitizeAnalyticsUrl("")).toBeNull();
  });
});

describe("sanitizeAnalyticsProperties", () => {
  it("drops unknown keys, nested objects and oversized values", () => {
    const out = sanitizeAnalyticsProperties({
      event_name: "page_viewed",
      email: "a@b.com",
      subtotalCents: 999999,
      properties: { url: "https://x.com/p?email=a@b.com", product_title: "T".repeat(500), nested: { a: 1 }, quantity: 2 },
    });
    expect(out).toEqual({ url: "/p", product_title: "T".repeat(200), quantity: 2 });
  });
  it("cannot forge dashboard fields read by the admin analytics", () => {
    const out = sanitizeAnalyticsProperties({ properties: { subtotalCents: 5, savedCents: 5, giftProductTitle: "x" } });
    expect(out).toEqual({});
  });
  it("accepts numeric ids and rejects non-finite quantity", () => {
    expect(sanitizeAnalyticsProperties({ properties: { order_id: 12345, quantity: Number.POSITIVE_INFINITY } })).toEqual({ order_id: "12345" });
  });
});
