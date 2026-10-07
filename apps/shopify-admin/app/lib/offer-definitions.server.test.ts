import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("./redis.server.js", () => ({
  redisGetString: redis.get,
  redisSetString: redis.set,
  redisDelete: redis.del,
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const { resetMemoryCaches } = await import("./memory-cache.server.js");
const { getOfferDefinitions, invalidateOfferDefinitions } = await import("./offer-definitions.server.js");

function fakeDb(rows: unknown[]) {
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain["from"] = () => chain;
    chain["where"] = () => chain;
    chain["orderBy"] = () => Promise.resolve(rows);
    chain["then"] = (resolve: (value: unknown[]) => void) => resolve([]);
    return chain;
  });
  return { select } as never;
}

const row = {
  id: "o1", type: "gift", status: "active", internalName: "n", publicTitle: null, description: null, priority: 1,
  startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: null, timezone: "UTC", discountTags: [], createdBy: null, archivedAt: null,
};

beforeEach(() => {
  resetMemoryCaches();
  store.clear();
  redis.get.mockReset().mockImplementation(async (key: string) => store.get(key) ?? null);
  redis.set.mockReset().mockImplementation(async (key: string, value: string) => void store.set(key, value));
  redis.del.mockReset().mockImplementation(async (key: string) => void store.delete(key));
});

describe("getOfferDefinitions cache", () => {
  it("reads the DB once, then serves from Redis with Date fields revived", async () => {
    const db = fakeDb([row]);
    const first = await getOfferDefinitions("shop-1", db);
    const second = await getOfferDefinitions("shop-1", db);
    const selects = (db as unknown as { select: ReturnType<typeof vi.fn> }).select;
    expect(selects).toHaveBeenCalledTimes(4);
    expect(second).toEqual(first);
    expect(second[0]!.startsAt).toBeInstanceOf(Date);
    expect(redis.set).toHaveBeenCalledWith("od:v1:shop-1", expect.any(String), 30);
  });

  it("hashes the same version whatever the offer's code redemption mode", async () => {
    const { computeOfferVersion } = await import("./offer-version.server.js");
    const defs = await getOfferDefinitions("shop-mode", fakeDb([row]));
    const fullRow = { ...row, requiresCode: true, requiredDiscountCode: null, codeDiscountId: null, codeRedemption: "automatic" };
    expect(defs[0]!.version).toBe(computeOfferVersion(fullRow, [], [], null));
  });

  it("re-reads the DB after invalidateOfferDefinitions", async () => {
    const db = fakeDb([]);
    await getOfferDefinitions("shop-1", db);
    const calls = (db as unknown as { select: ReturnType<typeof vi.fn> }).select.mock.calls.length;
    await invalidateOfferDefinitions("shop-1");
    expect(redis.del).toHaveBeenCalledWith("od:v1:shop-1");
    await getOfferDefinitions("shop-1", db);
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select.mock.calls.length).toBe(calls * 2);
  });

  it("serves repeat reads from the in-process L1 without touching Redis", async () => {
    const db = fakeDb([row]);
    await getOfferDefinitions("shop-l1", db);
    redis.get.mockClear();
    const again = await getOfferDefinitions("shop-l1", db);
    expect(redis.get).not.toHaveBeenCalled();
    expect(again[0]!.startsAt).toBeInstanceOf(Date);
  });

  it("does not extend the L1 TTL on hits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const db = fakeDb([row]);
      await getOfferDefinitions("shop-ttl", db);
      redis.get.mockClear();
      vi.advanceTimersByTime(6_000);
      await getOfferDefinitions("shop-ttl", db);
      vi.advanceTimersByTime(6_000);
      expect(redis.get).not.toHaveBeenCalled();
      await getOfferDefinitions("shop-ttl", db);
      expect(redis.get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the DB when Redis has nothing or the entry is corrupt", async () => {
    store.set("od:v1:shop-2", "{not json");
    const db = fakeDb([]);
    await expect(getOfferDefinitions("shop-2", db)).resolves.toEqual([]);
    expect(redis.set).toHaveBeenCalled();
  });
});
