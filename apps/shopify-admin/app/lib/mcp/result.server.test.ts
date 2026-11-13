import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_TYPES,
  ToolError,
  ERROR_CODES,
  buildResult,
  capacityToolError,
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

describe("capacityToolError", () => {
  it("is a CAPACITY_LIMIT error naming the Shopify cap and the workarounds, like the admin modal", () => {
    expect(ERROR_CODES).toContain("CAPACITY_LIMIT");
    const e = capacityToolError(
      { code: "AUTOMATIC_DISCOUNT_LIMIT", offerIds: ["o1"], numbers: { needed: 2, storeActive: 24, others: 20 }, offerNames: { o1: "Protein" } },
      "Activation blocked.",
    );
    expect(e.payload).toMatchObject({ code: "CAPACITY_LIMIT", retryable: false });
    expect(e.payload.message).toContain("Activation blocked.");
    expect(e.payload.message).toMatch(/25 active automatic discounts/);
    expect(e.payload.details?.capacity).toEqual({ code: "AUTOMATIC_DISCOUNT_LIMIT", offerIds: ["o1"], numbers: { needed: 2, storeActive: 24, others: 20 } });
    expect(e.payload.details?.limit).toMatch(/25 active automatic discounts per store/);
    expect(e.payload.details?.workarounds?.map((w) => w.kind)).toEqual(["deactivate_discounts"]);
  });
  it("offers whole-products and split for an oversized offer, pause for a full slot, and survives unknown codes", () => {
    const large = capacityToolError({ code: "OFFER_TOO_LARGE", offerIds: ["o1"], numbers: { bytes: 90000, slotBytes: 60000 } }, "x");
    expect(large.payload.details?.workarounds?.map((w) => w.kind)).toEqual(["use_whole_products", "sync_products", "split_offer", "reduce_gift_options"]);
    expect(capacityToolError({ code: "SLOT_FULL", offerIds: [], numbers: {} }, "x").payload.details?.workarounds?.map((w) => w.kind)).toEqual(["pause_offers"]);
    const unknown = capacityToolError({ code: "SOMETHING_NEW", offerIds: [], numbers: {} }, "x");
    expect(unknown.payload).toMatchObject({ code: "CAPACITY_LIMIT", message: "x" });
    expect(unknown.payload.details?.workarounds).toEqual([]);
  });
});

describe("ToolError", () => {
  it("carries code, suggestedAction (nullable), mcp and retryable", () => {
    const e = new ToolError("STATE_CONFLICT", "nope", {
      suggestedAction: { mcp: "promo-engine", tool: "shops_list", args: {}, why: "see write shops" },
    });
    expect(e.payload).toMatchObject({ code: "STATE_CONFLICT", mcp: "promo-engine", retryable: false });
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
