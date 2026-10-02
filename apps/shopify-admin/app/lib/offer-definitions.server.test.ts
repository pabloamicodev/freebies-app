import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("./redis.server.js", () => ({
  redisGetString: redis.get,
  redisSetString: redis.set,
  redisDelete: redis.del,
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

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

  it("re-reads the DB after invalidateOfferDefinitions", async () => {
    const db = fakeDb([]);
    await getOfferDefinitions("shop-1", db);
    const calls = (db as unknown as { select: ReturnType<typeof vi.fn> }).select.mock.calls.length;
    await invalidateOfferDefinitions("shop-1");
    expect(redis.del).toHaveBeenCalledWith("od:v1:shop-1");
    await getOfferDefinitions("shop-1", db);
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select.mock.calls.length).toBe(calls * 2);
  });

  it("falls back to the DB when Redis has nothing or the entry is corrupt", async () => {
    store.set("od:v1:shop-2", "{not json");
    const db = fakeDb([]);
    await expect(getOfferDefinitions("shop-2", db)).resolves.toEqual([]);
    expect(redis.set).toHaveBeenCalled();
  });
});
