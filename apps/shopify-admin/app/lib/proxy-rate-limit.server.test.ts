import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rate-limit.server.js", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ ok: true }) }));
const { checkRateLimit } = await import("./rate-limit.server.js");
const { proxyRateLimitResponse } = await import("./proxy-rate-limit.server.js");

const req = (query = "", headers: Record<string, string> = {}) => new Request(`https://app.test/apps/promo-engine/bundle${query}`, { headers });

beforeEach(() => vi.mocked(checkRateLimit).mockReset().mockResolvedValue({ ok: true }));

describe("proxyRateLimitResponse", () => {
  it("never keys by IP, even when forwarding headers are present", async () => {
    await proxyRateLimitResponse(req("", { "x-forwarded-for": "1.2.3.4" }), "bundle", "shop-1", 120, 12_000);
    expect(vi.mocked(checkRateLimit).mock.calls.map((call) => call[0])).toEqual(["bundle:shop-1"]);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith("bundle:shop-1", { limit: 12_000, windowMs: 60_000, fixedWindow: true });
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
    expect(response?.headers.get("Retry-After")).toBe("9");
  });
});
