import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rate-limit.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
const insertValues = vi.fn().mockResolvedValue(undefined);
vi.mock("@promo/db", () => ({
  getDb: () => ({
    insert: () => ({ values: insertValues }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  }),
  analyticsEvents: {},
  offers: { id: "id", shopId: "shopId" },
  widgets: { id: "id", shopId: "shopId" },
}));
vi.mock("./proxy-shop.server.js", () => ({
  getSignedShopCached: vi.fn().mockResolvedValue({ id: "shop-1", loggedInCustomerId: null }),
}));

const { action } = await import("../routes/apps.promo-engine.analytics.js");
const { checkRateLimit } = await import("./rate-limit.server.js");

const post = (body: unknown) =>
  action({
    request: new Request("https://app.test/apps/promo-engine/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);

const event = (name: string, sessionId?: string, extra: Record<string, unknown> = {}) => ({
  event: name,
  ...(sessionId ? { session_id: sessionId } : {}),
  ...extra,
});

beforeEach(() => {
  vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ ok: true });
  insertValues.mockClear();
});

describe("analytics ingestion", () => {
  it("rate-limits every distinct session in a batch, not only the first event's", async () => {
    const response = await post({ events: [event("page_viewed", "s-a"), event("page_viewed", "s-b"), event("page_viewed", "s-a")] });
    expect(response.status).toBe(202);
    const sessionKeys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]).filter((key) => key.includes(":s:"));
    expect(sessionKeys.sort()).toEqual(["analytics:shop-1:s:s-a", "analytics:shop-1:s:s-b"]);
  });

  it("rejects the batch when a later session is over its limit", async () => {
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => (key.endsWith(":s:s-b") ? { ok: false, retryAfterSeconds: 9 } : { ok: true }));
    const response = await post({ events: [event("page_viewed", "s-a"), event("page_viewed", "s-b")] });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(9);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("puts events without a session id in one shared bucket instead of skipping the limit", async () => {
    await post({ events: [event("page_viewed")] });
    expect(vi.mocked(checkRateLimit).mock.calls.map((c) => c[0])).toContain("analytics:shop-1:s:none");
  });

  it("refuses a batch spanning too many sessions", async () => {
    const events = Array.from({ length: 11 }, (_, i) => event("page_viewed", `s-${i}`));
    expect((await post({ events })).status).toBe(400);
  });

  it("never stores a client-supplied total_value or order_id", async () => {
    await post({ events: [event("page_viewed", "s-a", { total_value: "9999", order_id: "1001", product_id: "p1" })] });
    const rows = insertValues.mock.calls[0]![0] as Array<{ properties: Record<string, unknown> }>;
    expect(rows[0]!.properties).toEqual({ product_id: "p1" });
  });

  it("applies the env-configurable shop cap with Redis-only enforcement", async () => {
    process.env["ANALYTICS_SHOP_LIMIT_PER_MINUTE"] = "3000";
    try {
      await post({ events: [event("page_viewed", "s-a")] });
      expect(checkRateLimit).toHaveBeenCalledWith("analytics:shop-1", { limit: 3000, windowMs: 60_000, fixedWindow: true, onRedisUnavailable: "skip" });
    } finally {
      delete process.env["ANALYTICS_SHOP_LIMIT_PER_MINUTE"];
    }
  });
});
