import { describe, expect, it } from "vitest";
import { scrubSentryEvent } from "./sentry-scrub.server.js";

describe("scrubSentryEvent", () => {
  it("removes cookies, auth headers, client IPs and signed proxy params", () => {
    const event = scrubSentryEvent({
      type: undefined,
      request: {
        url: "https://app.test/apps/promo-engine/evaluate?shop=a.myshopify.com&signature=abc&logged_in_customer_id=42&timestamp=1",
        cookies: { a: "b" },
        data: { email: "x@y.com" },
        query_string: "shop=a.myshopify.com&signature=abc&logged_in_customer_id=42",
        headers: { Authorization: "Bearer secret", "user-agent": "ua", "x-forwarded-for": "1.2.3.4" },
      },
      user: { id: "u1", email: "x@y.com", ip_address: "1.2.3.4" },
    });
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toEqual({ "user-agent": "ua" });
    expect(event.request?.query_string).toBe("shop=a.myshopify.com&signature=[redacted]&logged_in_customer_id=[redacted]");
    expect(event.request?.url).toContain("signature=[redacted]");
    expect(event.request?.url).not.toContain("42");
    expect(event.user).toEqual({ id: "u1" });
  });

  it("masks emails and Shopify tokens in messages, extras and exceptions", () => {
    const event = scrubSentryEvent({
      type: undefined,
      message: "failed for jane@example.com",
      extra: { detail: { token: "shpat_0123456789abcdef0123", note: "mail bob@x.io" } },
      exception: { values: [{ value: "Bearer abcdefghijklmnopqrstuvwxyz rejected" }] },
    });
    expect(event.message).toBe("failed for [email]");
    expect(JSON.stringify(event.extra)).not.toMatch(/shpat_|bob@/);
    expect(event.exception?.values?.[0]?.value).toBe("[secret] rejected");
  });
});

describe("scrubSentryEvent: query params, breadcrumbs, discount codes", () => {
  it("redacts any param ending in code/token/email, case-insensitively, in urls and query strings", () => {
    const event = scrubSentryEvent({
      type: undefined,
      request: {
        url: "https://s.test/cart?freegifts_code=SECRET1&Discount_Code=SECRET2&access_token=abc&UserEmail=a@b.co&utm_source=news&x=1#frag",
        query_string: "freegifts_code=SECRET1&utm_source=news&AuthToken=zzz",
      },
    });
    expect(event.request?.url).toBe("https://s.test/cart?freegifts_code=[redacted]&Discount_Code=[redacted]&access_token=[redacted]&UserEmail=[redacted]&utm_source=news&x=1#frag");
    expect(event.request?.query_string).toBe("freegifts_code=[redacted]&utm_source=news&AuthToken=[redacted]");
  });

  it("scrubs query strings inside breadcrumb data.url and message", () => {
    const event = scrubSentryEvent({
      type: undefined,
      breadcrumbs: [
        { category: "fetch", message: "POST https://s.test/apps/promo-engine/evaluate?signature=abc&code=SAVE20", data: { url: "/cart.js?discount_code=SAVE20&shop=a.myshopify.com", status_code: 200 } },
        { category: "navigation", data: { from: "/p?token=t1", to: "/c?email=x@y.com" } },
      ],
    });
    const text = JSON.stringify(event.breadcrumbs);
    expect(text).not.toMatch(/SAVE20|abc|t1|x@y\.com/);
    expect(text).toContain("shop=a.myshopify.com");
    expect(event.breadcrumbs?.[0]?.data?.["status_code"]).toBe(200);
  });

  it("redacts discount codes in extras whatever their shape", () => {
    const event = scrubSentryEvent({
      type: undefined,
      extra: {
        discountCodes: ["SAVE20", "VIP"],
        requiredDiscountCode: "LEGACY",
        entered_codes: ["A"],
        nested: { coupon_code: "C1", cartToken: "tk9", kept: "ok", error_code: "RATE_LIMITED" },
      },
    });
    const text = JSON.stringify(event.extra);
    expect(text).not.toMatch(/SAVE20|VIP|LEGACY|"A"|C1|tk9/);
    expect(text).toContain("RATE_LIMITED");
    expect(text).toContain("ok");
  });
});
