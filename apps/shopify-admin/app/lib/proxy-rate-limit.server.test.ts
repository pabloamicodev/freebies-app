import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rate-limit.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
const { checkRateLimit } = await import("./rate-limit.server.js");
const { proxyRateLimitResponse } = await import("./proxy-rate-limit.server.js");

const req = (query = "", headers: Record<string, string> = {}) => new Request(`https://app.test/apps/promo-engine/bundle${query}`, { headers });

beforeEach(() => vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ ok: true }));

describe("proxyRateLimitResponse", () => {
  it("never keys by IP, even when forwarding headers are present", async () => {
    await proxyRateLimitResponse(req("", { "x-forwarded-for": "1.2.3.4" }), "bundle", "shop-1", 120, 12_000);
    expect(vi.mocked(checkRateLimit).mock.calls.map((call) => call[0])).toEqual(["bundle:shop-1"]);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith("bundle:shop-1", { limit: 12_000, windowMs: 60_000, fixedWindow: true, onRedisUnavailable: "skip" });
  });

  it("adds a per-customer limit only for a numeric signed customer id", async () => {
    await proxyRateLimitResponse(req("?logged_in_customer_id=42"), "bundle", "shop-1", 120);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith("bundle:shop-1:c:42", { limit: 120, windowMs: 60_000 });
    vi.mocked(checkRateLimit).mockClear();
    await proxyRateLimitResponse(req("?logged_in_customer_id=abc"), "bundle", "shop-1", 120);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledTimes(1);
  });

  it("returns 429 with Retry-After when the shop ceiling is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: false, retryAfterSeconds: 9 });
    const response = await proxyRateLimitResponse(req(), "bundle", "shop-1", 120);
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThanOrEqual(9);
    expect(Number(response?.headers.get("Retry-After"))).toBeLessThanOrEqual(19);
  });

  it("reads the shop ceiling from <SCOPE>_SHOP_LIMIT_PER_MINUTE", async () => {
    process.env["PRODUCT_CUSTOMIZATIONS_SHOP_LIMIT_PER_MINUTE"] = "40000";
    try {
      await proxyRateLimitResponse(req(), "product-customizations", "shop-1", 240, 24_000);
      expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith("product-customizations:shop-1", expect.objectContaining({ limit: 40_000 }));
    } finally {
      delete process.env["PRODUCT_CUSTOMIZATIONS_SHOP_LIMIT_PER_MINUTE"];
    }
  });
});
