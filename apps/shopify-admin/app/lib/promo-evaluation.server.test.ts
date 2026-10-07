import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./rate-limit.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  getClientIp: vi.fn().mockReturnValue("203.0.113.1"),
}));
vi.mock("./redis.server.js", () => ({
  redisGetString: vi.fn().mockResolvedValue(null),
  redisSetString: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("./code-gate.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyCodeGatesDetailed: vi.fn(async (_shopId: string, _db: unknown, definitions: unknown[]) => ({ definitions, blocked: false, truncated: false })),
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
const { redisGetString, redisSetString } = await import("./redis.server.js");
const { resetMemoryCaches } = await import("./memory-cache.server.js");
const { applyCodeGatesDetailed } = await import("./code-gate.server.js");
const { waitUntil } = await import("@vercel/functions");

function makeRequest(cartToken: string | null, discountCodes: string[] = []) {
  const body = {
    cart: {
      token: cartToken,
      id: null,
      lines: [],
      subtotalCents: 0,
      discountCodes,
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
    resetMemoryCaches();
    vi.mocked(checkRateLimit).mockClear().mockResolvedValue({ ok: true });
    vi.mocked(getOfferDefinitions).mockClear();
    vi.mocked(getClientIp).mockClear().mockReturnValue("203.0.113.1");
  });

  it("checks a shop-wide fixed-window ceiling keyed only by shop id", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, null);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop:shop-1", {
      limit: 12_000,
      windowMs: 60_000,
      fixedWindow: true,
      onRedisUnavailable: "skip",
    });
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

  it("uses fixed-window counters for every per-caller limit (customer, cart token, IP)", async () => {
    await handleEvaluationRequest(makeRequest("cart-tok-1"), shop, "42");
    const calls = vi.mocked(checkRateLimit).mock.calls.filter(([key]) => key !== "evaluate:shop:shop-1");
    expect(calls.map(([key]) => key)).toEqual(["evaluate:shop-1:c:42", "evaluate:shop-1:t:cart-tok-1", "evaluate:shop-1:ip:203.0.113.1"]);
    for (const [, options] of calls) expect(options).toMatchObject({ windowMs: 60_000, fixedWindow: true });
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
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(7);
  });
});

describe("H6: anonymous traffic cannot spend the budget of known shoppers", () => {
  const proxy = { viaAppProxy: true };
  beforeEach(() => {
    resetMemoryCaches();
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(redisGetString).mockReset().mockResolvedValue(null);
    vi.mocked(redisSetString).mockClear();
    vi.mocked(waitUntil).mockClear();
    delete process.env["EVALUATE_SHOP_LIMIT_PER_MINUTE"];
    delete process.env["EVALUATE_KNOWN_SHOP_LIMIT_PER_MINUTE"];
  });

  it("counts a cart token that completed an evaluation before against its own, larger shop budget", async () => {
    vi.mocked(redisGetString).mockResolvedValueOnce("1");
    await handleEvaluationRequest(makeRequest("seen-tok"), shop, null, undefined, proxy);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop-known:shop-1", { limit: 36_000, windowMs: 60_000, fixedWindow: true, onRedisUnavailable: "skip" });
    expect(vi.mocked(checkRateLimit).mock.calls.map((call) => call[0])).not.toContain("evaluate:shop:shop-1");
    expect(redisSetString).not.toHaveBeenCalled();
  });

  it("skips the seen-cart GET on a warm instance once the cart is known", async () => {
    await handleEvaluationRequest(makeRequest("warm-tok"), shop, null, undefined, proxy);
    expect(redisGetString).toHaveBeenCalledTimes(1);
    expect(redisSetString).toHaveBeenCalledTimes(1);
    await handleEvaluationRequest(makeRequest("warm-tok"), shop, null, undefined, proxy);
    expect(redisGetString).toHaveBeenCalledTimes(1);
    expect(redisSetString).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenLastCalledWith("evaluate:shop-known:shop-1", expect.anything());
  });

  it("sheds an unknown caller on the anonymous budget while a known one is not affected by it", async () => {
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => (key === "evaluate:shop:shop-1" ? { ok: false, retryAfterSeconds: 20 } : { ok: true }));
    expect((await handleEvaluationRequest(makeRequest(null), shop, null, undefined, proxy)).status).toBe(429);
    expect((await handleEvaluationRequest(makeRequest("never-seen"), shop, null, undefined, proxy)).status).toBe(429);

    vi.mocked(redisGetString).mockResolvedValueOnce("1");
    expect((await handleEvaluationRequest(makeRequest("seen-tok"), shop, null, undefined, proxy)).status).toBe(200);
  });

  it("remembers the cart token after a successful evaluation, not after a shed one", async () => {
    await handleEvaluationRequest(makeRequest("new-tok"), shop, null, undefined, proxy);
    expect(redisSetString).toHaveBeenCalledWith("evaluate:seen:shop-1:new-tok", "1", 1800);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    vi.mocked(redisSetString).mockClear();
    vi.mocked(checkRateLimit).mockResolvedValue({ ok: false, retryAfterSeconds: 5 });
    await handleEvaluationRequest(makeRequest("shed-tok"), shop, null, undefined, proxy);
    expect(redisSetString).not.toHaveBeenCalled();
  });

  it("reads the caps from the environment", async () => {
    process.env["EVALUATE_SHOP_LIMIT_PER_MINUTE"] = "5000";
    await handleEvaluationRequest(makeRequest("t"), shop, null, undefined, proxy);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop:shop-1", expect.objectContaining({ limit: 5000 }));
    vi.mocked(checkRateLimit).mockClear();
    vi.mocked(redisGetString).mockResolvedValueOnce("1");
    process.env["EVALUATE_KNOWN_SHOP_LIMIT_PER_MINUTE"] = "7000";
    await handleEvaluationRequest(makeRequest("t"), shop, null, undefined, proxy);
    expect(checkRateLimit).toHaveBeenCalledWith("evaluate:shop-known:shop-1", expect.objectContaining({ limit: 7000 }));
    delete process.env["EVALUATE_SHOP_LIMIT_PER_MINUTE"];
    delete process.env["EVALUATE_KNOWN_SHOP_LIMIT_PER_MINUTE"];
  });

  it("answers 429 with a jittered Retry-After of at least the window remainder", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const response = await handleEvaluationRequest(makeRequest("x"), shop, null, undefined, proxy);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(30);
    expect(retryAfter).toBeLessThanOrEqual(40);
  });
});

describe("H5: discount codes need a cart token on the app proxy", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(applyCodeGatesDetailed).mockClear();
  });

  it("rejects a proxy request with codes and no cart token before any lookup", async () => {
    const response = await handleEvaluationRequest(makeRequest(null, ["GUESS1"]), shop, null, undefined, { viaAppProxy: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CART_TOKEN_REQUIRED" });
    expect(applyCodeGatesDetailed).not.toHaveBeenCalled();
  });

  it("still accepts a token-less proxy request that carries no codes, and codes with a token", async () => {
    expect((await handleEvaluationRequest(makeRequest(null), shop, null, undefined, { viaAppProxy: true })).status).toBe(200);
    expect((await handleEvaluationRequest(makeRequest(null, ["  "]), shop, null, undefined, { viaAppProxy: true })).status).toBe(200);
    expect((await handleEvaluationRequest(makeRequest("tok", ["CODE1"]), shop, null, undefined, { viaAppProxy: true })).status).toBe(200);
  });

  it("keys the missed-code limit by the cart token, else the signed customer, else one shared anonymous bucket", async () => {
    const keyOf = () => vi.mocked(applyCodeGatesDetailed).mock.calls.at(-1)![5]!.rateLimitKey;
    await handleEvaluationRequest(makeRequest("tok-9", ["A"]), shop, "42", undefined, { viaAppProxy: true });
    expect(keyOf()).toBe("tok-9");
    await handleEvaluationRequest(makeRequest(null, ["A"]), shop, "42");
    expect(keyOf()).toBe("c:42");
    await handleEvaluationRequest(makeRequest(null, ["A"]), shop, null);
    expect(keyOf()).toBe("anon");
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
