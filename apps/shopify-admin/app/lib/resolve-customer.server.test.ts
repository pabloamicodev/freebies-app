/**
 * Unit tests for resolve-customer.server.ts
 * Covers the cache-hit/miss/Redis-unavailable paths around the Admin API call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (registered before importing the module under test) ───────────────

const mockShopifyGraphQL = vi.fn();
vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: (...args: unknown[]) => mockShopifyGraphQL(...args),
}));

let redisStore: Map<string, string> | null = new Map();

const ttlByKey = new Map<string, number>();
// redisGetString/redisSetString swallow Redis errors and return null/void, so a null store models both "unavailable" and "throws".
const mockGet = vi.fn(async (key: string) => redisStore?.get(key) ?? null);
const mockSet = vi.fn(async (key: string, value: string, ttl: number) => {
  if (!redisStore) return;
  redisStore.set(key, value);
  ttlByKey.set(key, ttl);
});

vi.mock("./redis.server.js", () => ({
  redisGetString: (key: string) => mockGet(key),
  redisSetString: (key: string, value: string, ttl: number) => mockSet(key, value, ttl),
}));

// Import AFTER mocks are registered
const { FAILURE_CACHE_TTL_SECONDS, resolveCustomer } = await import("./resolve-customer.server.js");

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeQueryResult(overrides: Partial<{ tags: string[]; numberOfOrders: string; amount: string }> = {}) {
  return {
    customer: {
      id: "gid://shopify/Customer/123",
      tags: overrides.tags ?? ["vip"],
      numberOfOrders: overrides.numberOfOrders ?? "3",
      amountSpent: { amount: overrides.amount ?? "150.00" },
      defaultAddress: { countryCodeV2: "US" },
      lastOrder: { nodes: [{ totalPriceSet: { shopMoney: { amount: "50.00" } } }] },
    },
  };
}

const SHOP_DOMAIN = "test-shop.myshopify.com";
const ACCESS_TOKEN = "plain-access-token"; // not in encrypted format, decryptToken returns as-is

describe("resolveCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStore = new Map();
    ttlByKey.clear();
  });

  it("returns null without calling the Admin API for an invalid customer id", async () => {
    const result = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, null);
    expect(result).toBeNull();
    expect(mockShopifyGraphQL).not.toHaveBeenCalled();
  });

  it("cache miss: calls the Admin API and caches the result", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(makeQueryResult());

    const result = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");

    expect(result).toMatchObject({ id: "gid://shopify/Customer/123", tags: ["vip"], totalOrders: 3 });
    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
    expect(redisStore?.size).toBe(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("cache hit: skips the Admin API call within the TTL window", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce(makeQueryResult());

    const first = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");
    const second = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");

    expect(first).toEqual(second);
    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
  });

  it("caches a null profile (customer not found) to avoid repeat lookups", async () => {
    mockShopifyGraphQL.mockResolvedValueOnce({ customer: null });

    const first = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "999");
    const second = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "999");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
  });

  it("falls back to a direct call when Redis is unavailable, without throwing", async () => {
    redisStore = null; // simulates getSharedRedis() resolving to null
    mockShopifyGraphQL.mockResolvedValue(makeQueryResult());

    const first = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");
    const second = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // No cache available, so every call must hit the Admin API directly.
    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(2);
  });

  it("fails open when Redis throws on read/write, still returning the resolved profile", async () => {
    redisStore = null;
    mockShopifyGraphQL.mockResolvedValueOnce(makeQueryResult());

    const result = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");

    expect(result).not.toBeNull();
    expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
  });

  it("still fails open (returns null) when the Admin API call itself errors", async () => {
    mockShopifyGraphQL.mockRejectedValueOnce(new Error("timeout"));

    const result = await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");

    expect(result).toBeNull();
  });

  describe("cache lifetime", () => {
    const onlyTtl = () => [...ttlByKey.values()][0];

    it("caches a successful profile for 45 seconds", async () => {
      mockShopifyGraphQL.mockResolvedValueOnce(makeQueryResult());
      await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");
      expect(onlyTtl()).toBe(45);
    });

    it("caches a customer that does not exist for 45 seconds too: that answer is stable", async () => {
      mockShopifyGraphQL.mockResolvedValueOnce({ customer: null });
      await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "999");
      expect(onlyTtl()).toBe(45);
    });

    it("caches a FAILED lookup for only 5 seconds, so one blip doesn't hide the customer's tags for 45", async () => {
      mockShopifyGraphQL.mockRejectedValueOnce(new Error("timeout"));
      expect(await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123")).toBeNull();
      expect(FAILURE_CACHE_TTL_SECONDS).toBe(5);
      expect(onlyTtl()).toBe(5);
    });

    it("still avoids hammering the Admin API during that short window", async () => {
      mockShopifyGraphQL.mockRejectedValueOnce(new Error("throttled"));
      await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");
      await resolveCustomer(SHOP_DOMAIN, ACCESS_TOKEN, "123");
      expect(mockShopifyGraphQL).toHaveBeenCalledTimes(1);
    });
  });
});
