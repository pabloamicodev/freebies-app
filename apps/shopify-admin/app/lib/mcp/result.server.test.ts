import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_TYPES,
  ToolError,
  buildResult,
  moneyFromMinor,
  parsePromoRef,
  promoRef,
  shopHandle,
  toToolErrorPayload,
} from "./result.server.js";

describe("buildResult", () => {
  it("fills the contract defaults with an ISO UTC generatedAt", () => {
    const result = buildResult({ summary: "s", data: { a: 1 } }, () => new Date("2026-11-03T10:00:00Z"));
    expect(result).toEqual({
      summary: "s",
      data: { a: 1 },
      links: [],
      warnings: [],
      nextActions: [],
      meta: { generatedAt: "2026-11-03T10:00:00.000Z" },
    });
  });
  it("keeps meta extras and perShop", () => {
    const result = buildResult({
      summary: "s",
      data: null,
      perShop: [{ shopDomain: "a.myshopify.com", shopHandle: "a", shopTimezone: "UTC", currency: "USD", status: "ok" }],
      meta: { shopTimezone: "UTC", page: { hasMore: false } },
      nextActions: [{ mcp: "promo-engine", tool: "shops_list", args: {}, why: "w", risk: "read" }],
    });
    expect(result.perShop).toHaveLength(1);
    expect(result.meta.page).toEqual({ hasMore: false });
    expect(result.nextActions[0]!.mcp).toBe("promo-engine");
  });
});

describe("ToolError", () => {
  it("carries code, suggestedAction (nullable), mcp and retryable", () => {
    const e = new ToolError("SHOP_READ_ONLY", "nope", {
      suggestedAction: { mcp: "promo-engine", tool: "shops_list", args: {}, why: "see write shops" },
    });
    expect(e.payload).toMatchObject({ code: "SHOP_READ_ONLY", mcp: "promo-engine", retryable: false });
    expect(e.payload.suggestedAction?.tool).toBe("shops_list");
    expect(new ToolError("VALIDATION", "x").payload.suggestedAction).toBeNull();
    expect(new ToolError("RATE_LIMITED", "x", { retryAfterSeconds: 3 }).payload).toMatchObject({ retryable: true, retryAfterSeconds: 3 });
    expect(new ToolError("CONFIRM_REQUIRED", "x", { confirmToken: "t" }).payload.confirmToken).toBe("t");
  });
  it("hides unknown errors behind INTERNAL", () => {
    const payload = toToolErrorPayload(new Error("select * from shops where token = 'secret'"));
    expect(payload.code).toBe("INTERNAL");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});

describe("refs and money", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("builds and parses promo refs by shop handle", () => {
    expect(shopHandle("hpn-test-store.myshopify.com")).toBe("hpn-test-store");
    expect(promoRef("hpn-test-store.myshopify.com", id)).toBe(`promo:hpn-test-store:${id}`);
    expect(parsePromoRef(`promo:hpn-test-store:${id}`)).toEqual({ shopHandle: "hpn-test-store", offerId: id });
    expect(parsePromoRef("promo:x:not-a-uuid")).toBeNull();
    expect(parsePromoRef("exp:x:" + id)).toBeNull();
  });
  it("formats minor units as decimal strings", () => {
    expect(moneyFromMinor(1234, "usd")).toEqual({ amount: "12.34", currency: "USD" });
    expect(moneyFromMinor(5, "EUR")).toEqual({ amount: "0.05", currency: "EUR" });
    expect(moneyFromMinor(-250, "EUR")).toEqual({ amount: "-2.50", currency: "EUR" });
    expect(moneyFromMinor(150000, "JPY")).toEqual({ amount: "1500", currency: "JPY" });
    expect(moneyFromMinor(123456, "KWD")).toEqual({ amount: "1234.560", currency: "KWD" });
    expect(moneyFromMinor(-5, "KWD")).toEqual({ amount: "-0.050", currency: "KWD" });
  });
  it("exposes the shared experiment type enum", () => {
    expect(EXPERIMENT_TYPES).toContain("OFFER_TEST");
    expect(EXPERIMENT_TYPES).toHaveLength(12);
  });
});
