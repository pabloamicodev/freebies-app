import { beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("./redis.server.js", () => ({ redisGetString: redis.get, redisSetString: redis.set, redisDelete: redis.del }));
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
const select = vi.hoisted(() => vi.fn());
vi.mock("@promo/db", () => ({
  shops: {},
  getDb: () => ({ select }),
}));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("./app-proxy-auth.server.js", () => ({ verifyAppProxySignature: vi.fn() }));

const { loadActiveShop, invalidateShopCache } = await import("./proxy-shop.server.js");
const { resetMemoryCaches } = await import("./memory-cache.server.js");
const { isShadowModeEnabled } = await import("./shadow-mode.server.js");

const shop = { id: "s1", currencyCode: "USD", accessTokenEncrypted: "enc" };

beforeEach(() => {
  resetMemoryCaches();
  redis.get.mockReset().mockResolvedValue(null);
  redis.set.mockReset().mockResolvedValue(undefined);
  redis.del.mockReset().mockResolvedValue(undefined);
  rows.value = [shop];
  select.mockReset().mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain["from"] = () => chain;
    chain["where"] = () => chain;
    chain["limit"] = () => Promise.resolve(rows.value);
    return chain;
  });
});

describe("loadActiveShop L1", () => {
  it("reads Redis/DB once, then serves repeats from memory", async () => {
    await loadActiveShop("a.myshopify.com");
    await loadActiveShop("a.myshopify.com");
    expect(select).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it("populates L1 from a Redis hit", async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify(shop));
    await loadActiveShop("b.myshopify.com");
    await loadActiveShop("b.myshopify.com");
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("invalidateShopCache drops the L1 entry", async () => {
    await loadActiveShop("c.myshopify.com");
    await invalidateShopCache("c.myshopify.com");
    await loadActiveShop("c.myshopify.com");
    expect(redis.del).toHaveBeenCalledWith("shop:v1:c.myshopify.com");
    expect(redis.get).toHaveBeenCalledTimes(2);
  });
});

describe("L1 expiry", () => {
  it("does not extend the TTL on hits: goes back to Redis once it elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await loadActiveShop("d.myshopify.com");
      vi.advanceTimersByTime(6_000);
      await loadActiveShop("d.myshopify.com");
      vi.advanceTimersByTime(6_000);
      expect(redis.get).toHaveBeenCalledTimes(1);
      await loadActiveShop("d.myshopify.com");
      expect(redis.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isShadowModeEnabled L1", () => {
  it("skips Redis on repeat reads", async () => {
    redis.get.mockResolvedValueOnce("1");
    expect(await isShadowModeEnabled("s1")).toBe(true);
    expect(await isShadowModeEnabled("s1")).toBe(true);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });
});
