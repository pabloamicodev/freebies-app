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
