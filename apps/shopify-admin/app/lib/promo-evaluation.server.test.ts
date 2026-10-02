import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./rate-limit.server.js", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getClientIp: vi.fn().mockReturnValue("203.0.113.1"),
}));
vi.mock("./offer-definitions.server.js", () => ({
  getOfferDefinitions: vi.fn().mockResolvedValue([]),
}));
vi.mock("./resolve-customer.server.js", () => ({
  resolveCustomer: vi.fn().mockResolvedValue(null),
}));
vi.mock("./upsell-enrichment.server.js", () => ({
  buildUpsells: vi.fn().mockResolvedValue([]),
}));
vi.mock("./gift-enrichment.server.js", () => ({
  collectGiftCatalogVariantIds: vi.fn().mockReturnValue([]),
  loadGiftCatalogData: vi.fn().mockResolvedValue(new Map()),
  enrichGiftSlider: vi.fn().mockReturnValue(null),
  loadGiftSliderTranslations: vi.fn().mockResolvedValue(null),
  resolveSoldOutGiftAdds: vi.fn().mockReturnValue([]),
}));
vi.mock("./shadow-mode.server.js", () => ({
  isShadowModeEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock("@promo/rule-engine", () => ({
  evaluate: vi.fn().mockResolvedValue({
    requestId: "req-1",
    cartHash: "hash",
    qualifiedOffers: [],
    disqualifiedOffers: [],
    cartActions: [],
    discountCodes: { add: [], remove: [] },
    giftSlider: null,
    cartMessages: [],
    progressBars: [],
    upsells: [],
    warnings: [],
    evaluatedAt: new Date().toISOString(),
  }),
}));

const { handleEvaluationRequest } = await import("./promo-evaluation.server.js");
const { checkRateLimit, getClientIp } = await import("./rate-limit.server.js");
const { getOfferDefinitions } = await import("./offer-definitions.server.js");

function makeRequest(cartToken: string | null) {
  const body = {
    cart: {
      token: cartToken,
      id: null,
      lines: [],
      subtotalCents: 0,
      discountCodes: [],
      currencyCode: "USD",
      totalQuantity: 0,
    },
    customer: null,
    market: null,
    locale: null,
    salesChannel: "online_store",
    requestedUrl: null,
    sessionId: "session-1",
  };
  return new Request("https://example.com/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const shop = {
  id: "shop-1",
  shopDomain: "test.myshopify.com",
  currencyCode: "USD",
  accessTokenEncrypted: "enc",
  db: {} as never,
};

describe("handleEvaluationRequest rate limit keys", () => {
  const keys = () => vi.mocked(checkRateLimit).mock.calls.map((call) => call[0]);
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockClear().mockResolvedValue({ ok: true });
    vi.mocked(getOfferDefinitions).mockClear();
    vi.mocked(getClientIp).mockClear().mockReturnValue("203.0.113.1");
  });

  it("checks a shop-wide fixed-window ceiling keyed only by shop id", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop:shop-1", { limit: 12_000, windowMs: 60_000, fixedWindow: true });
  });

  it("keys per-caller limits by the signed customer and by the cart token", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, "42", undefined, { viaAppProxy: true });
    expect(keys()).toEqual(["evaluate:shop:shop-1", "evaluate:shop-1:c:42", "evaluate:shop-1:t:cart-tok-1"]);
  });

  it("never keys by IP behind the app proxy", async () => {
    await handleEvaluationRequest(makeRequest(null), shop, null, undefined, { viaAppProxy: true });
    expect(keys()).toEqual(["evaluate:shop:shop-1"]);
    expect(getClientIp).not.toHaveBeenCalled();
  });

  it("uses IP only as a secondary key for direct callers", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(keys()).toEqual(["evaluate:shop:shop-1", "evaluate:shop-1:t:cart-tok-1", "evaluate:shop-1:ip:203.0.113.1"]);
  });

  it("returns 429 when the shop ceiling is hit, before touching offers", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: false, retryAfterSeconds: 10 });
    const response = await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null, undefined, { viaAppProxy: true });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many evaluation requests for this shop." });
    expect(getOfferDefinitions).not.toHaveBeenCalled();
  });

  it("returns 429 when a single cart token is over its limit", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, retryAfterSeconds: 7 });
    const response = await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null, undefined, { viaAppProxy: true });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
  });
});

describe("collectSpecificLinkParams", () => {
  it("returns the default plus every active specific_link param name, ignoring disabled and invalid ones", async () => {
    const { collectSpecificLinkParams } = await import("./promo-evaluation.server.js");
    const cond = (conditionType: string, value: unknown, isEnabled = true) => ({ conditionType, value, isEnabled });
    const offers = [
      { conditions: [cond("specific_link", { paramName: "promo" }), cond("specific_link", { paramName: "off" }, false)] },
      { conditions: [cond("specific_link", { paramName: "bad name!" }), cond("page_url", { paramName: "ignored" }), cond("specific_link", { param: "ref" })] },
    ];
    expect(collectSpecificLinkParams(offers as never)).toEqual(["freegifts_code", "promo", "ref"]);
    expect(collectSpecificLinkParams([])).toEqual(["freegifts_code"]);
  });
});

describe("ENABLE_STOREFRONT_RUNTIME kill switch", () => {
  it("answers with an inert result without touching rate limits or offers", async () => {
    process.env["ENABLE_STOREFRONT_RUNTIME"] = "false";
    try {
      vi.mocked(checkRateLimit).mockClear();
      vi.mocked(getOfferDefinitions).mockClear();
      const response = await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ cartActions: [], giftSlider: null, qualifiedOffers: [], specificLinkParams: [] });
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(getOfferDefinitions).not.toHaveBeenCalled();
    } finally {
      delete process.env["ENABLE_STOREFRONT_RUNTIME"];
    }
  });
});
