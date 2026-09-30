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

const mockEval = vi.fn(async (script: string, _numKeys: number, ...args: unknown[]) => {
  if (!redisStore) throw new Error("redis unavailable");
  const key = args[0] as string;
  if (script.includes("'GET'")) {
    return redisStore.get(key) ?? null;
  }
  // SET key value EX ttl
  const value = args[1] as string;
  redisStore.set(key, value);
  return "OK";
});

const mockGetSharedRedis = vi.fn(async () => (redisStore ? { eval: mockEval } : null));

vi.mock("./redis.server.js", () => ({
  getSharedRedis: () => mockGetSharedRedis(),
  recordRedisFailure: vi.fn(),
  resetSharedRedis: vi.fn(),
}));

// Import AFTER mocks are registered
const { resolveCustomer } = await import("./resolve-customer.server.js");

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
    mockGetSharedRedis.mockResolvedValue({
      eval: vi.fn().mockRejectedValue(new Error("boom")),
    });
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
});
