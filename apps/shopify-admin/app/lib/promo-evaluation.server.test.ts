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

describe("handleEvaluationRequest rate limit key", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockClear().mockResolvedValue({ ok: true });
    vi.mocked(getOfferDefinitions).mockClear();
    vi.mocked(getClientIp).mockClear().mockReturnValue("203.0.113.1");
  });

  it("checks a shop-wide ceiling keyed only by shop id", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop:shop-1", { limit: 3_000, windowMs: 60_000 });
  });

  it("keys the per-caller limit by the logged-in customer id when present", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, "gid://shopify/Customer/42");
    expect(checkRateLimit).toHaveBeenCalledWith(
      "evaluate:shop-1:gid://shopify/Customer/42",
      { limit: 120, windowMs: 60_000 },
    );
  });

  it("falls back to the cart token from the parsed body when anonymous", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "evaluate:shop-1:cart-tok-1",
      { limit: 120, windowMs: 60_000 },
    );
  });

  it("falls back to IP when there's no customer or cart token", async () => {
    await handleEvaluationRequest(makeRequest(null), shop, null);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "evaluate:shop-1:203.0.113.1",
      { limit: 120, windowMs: 60_000 },
    );
  });

  it("returns 429 when the shop ceiling is hit, checking both limits in parallel", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: false, retryAfterSeconds: 10 });
    const response = await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "Too many evaluation requests for this shop." });
    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(getOfferDefinitions).not.toHaveBeenCalled();
  });
});
