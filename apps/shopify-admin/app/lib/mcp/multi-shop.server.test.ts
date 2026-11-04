import { beforeEach, describe, expect, it } from "vitest";
import { clearFanOutCache, fanOut, type ShopRef } from "./multi-shop.server.js";

const shop = (n: number): ShopRef => ({ id: `id-${n}`, myshopifyDomain: `s${n}.myshopify.com`, timezone: "UTC", currencyCode: "USD" });

beforeEach(() => clearFanOutCache());

describe("fanOut", () => {
  it("returns ok for every shop in input order", async () => {
    const { perShop, results } = await fanOut([shop(1), shop(2)], async (s) => s.id);
    expect(perShop.map((p) => [p.shopDomain, p.status])).toEqual([
      ["s1.myshopify.com", "ok"],
      ["s2.myshopify.com", "ok"],
    ]);
    expect(results.map((r) => r.value)).toEqual(["id-1", "id-2"]);
    expect(perShop[0]).toMatchObject({ shopHandle: "s1", shopTimezone: "UTC", currency: "USD" });
  });

  it("one failing shop does not break the others and leaks no error text", async () => {
    const { perShop, results } = await fanOut([shop(1), shop(2), shop(3)], async (s) => {
      if (s.id === "id-2") throw new Error("token=secret");
      return s.id;
    });
    expect(perShop.map((p) => p.status)).toEqual(["ok", "error", "ok"]);
    expect(perShop[1]!.reason).toBe("error");
    expect(results).toHaveLength(2);
  });

  it("times out a slow shop", async () => {
    const { perShop } = await fanOut([shop(1)], () => new Promise(() => {}), { timeoutMs: 20 });
    expect(perShop[0]).toMatchObject({ status: "error", reason: "timeout" });
  });

  it("respects the concurrency cap", async () => {
    let running = 0;
    let peak = 0;
    await fanOut(
      [1, 2, 3, 4, 5, 6].map(shop),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
      },
      { concurrency: 2 },
    );
    expect(peak).toBe(2);
  });

  it("caches per (key, shop) until the ttl and can be invalidated per shop", async () => {
    let calls = 0;
    let clock = 1_000;
    const opts = { cacheKey: "t:a", cacheTtlMs: 100, now: () => clock };
    const run = () => fanOut([shop(1)], async () => ++calls, opts);
    await run();
    await run();
    expect(calls).toBe(1);
    clock += 101;
    await run();
    expect(calls).toBe(2);
    clearFanOutCache("id-1");
    await run();
    expect(calls).toBe(3);
  });

  it("does not cache failures and separates keys", async () => {
    let calls = 0;
    const failing = () => fanOut([shop(1)], async () => { calls += 1; throw new Error("x"); }, { cacheKey: "f" });
    await failing();
    await failing();
    expect(calls).toBe(2);
    const a = await fanOut([shop(1)], async () => "a", { cacheKey: "k1" });
    const b = await fanOut([shop(1)], async () => "b", { cacheKey: "k2" });
    expect([a.results[0]!.value, b.results[0]!.value]).toEqual(["a", "b"]);
  });
});
