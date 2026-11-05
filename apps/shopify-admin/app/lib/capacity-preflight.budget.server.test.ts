import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";

const store = new Map<string, string>();
const redisState = { down: false };
const budgetCall = vi.fn();

vi.mock("./redis.server.js", () => ({
  redisGetString: async (key: string) => {
    if (redisState.down) throw new Error("redis down");
    return store.get(key) ?? null;
  },
  redisSetString: async (key: string, value: string) => {
    if (redisState.down) throw new Error("redis down");
    store.set(key, value);
  },
}));
vi.mock("./discount-node.server.js", () => ({
  automaticNodeBudget: (...args: unknown[]) => budgetCall(...args),
  CART_SHARD_POOL_SETTING: "cart_shard_node_ids",
  MAX_CART_SLOTS: 11,
}));
vi.mock("./token-crypto.server.js", () => ({ decryptToken: async (value: string) => `plain-${value}` }));

import { loadAutomaticBudget } from "./capacity-preflight.server.js";

const shopRow = { domain: "s.myshopify.com", token: "enc" };
const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [shopRow] }) }) }),
} as unknown as Db;
const live = { storeActive: 10, ours: 2, others: 8, maxCartSlots: 9 };

beforeEach(() => {
  store.clear();
  redisState.down = false;
  budgetCall.mockReset();
  vi.useRealTimers();
});

describe("loadAutomaticBudget", () => {
  it("calls Shopify once and serves the next reads from Redis within 5 minutes", async () => {
    budgetCall.mockResolvedValue(live);
    expect(await loadAutomaticBudget(fakeDb, "shop1")).toEqual(live);
    expect(await loadAutomaticBudget(fakeDb, "shop1")).toEqual(live);
    expect(budgetCall).toHaveBeenCalledTimes(1);
    expect(budgetCall).toHaveBeenCalledWith("shop1", "s.myshopify.com", "plain-enc");
  });

  it("refreshes after 5 minutes", async () => {
    vi.useFakeTimers();
    budgetCall.mockResolvedValue(live);
    await loadAutomaticBudget(fakeDb, "shop1");
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    budgetCall.mockResolvedValue({ ...live, maxCartSlots: 4 });
    expect((await loadAutomaticBudget(fakeDb, "shop1"))?.maxCartSlots).toBe(4);
    expect(budgetCall).toHaveBeenCalledTimes(2);
  });

  it("falls back to the last known value when Shopify fails", async () => {
    vi.useFakeTimers();
    budgetCall.mockResolvedValue(live);
    await loadAutomaticBudget(fakeDb, "shop1");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    budgetCall.mockRejectedValue(new Error("shopify down"));
    expect(await loadAutomaticBudget(fakeDb, "shop1")).toEqual(live);
  });

  it("works without Redis and returns null when nothing is known", async () => {
    redisState.down = true;
    budgetCall.mockResolvedValue(live);
    expect(await loadAutomaticBudget(fakeDb, "shop1")).toEqual(live);
    budgetCall.mockRejectedValue(new Error("shopify down"));
    expect(await loadAutomaticBudget(fakeDb, "shop1")).toBeNull();
  });
});
