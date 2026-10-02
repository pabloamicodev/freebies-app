import type * as PromoDb from "@promo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { shops, type Db } from "@promo/db";
import { createTestDb, seedShop } from "./test-support/pglite-db.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
const waitUntil = vi.fn();
vi.mock("@vercel/functions", () => ({ waitUntil: (...args: unknown[]) => waitUntil(...args) }));
const captureException = vi.fn();
vi.mock("@sentry/node", () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

const { clearPublishPending, isLockTimeoutError, isPublishPending, markPublishPending, scheduleBackgroundPublishRetry } =
  await import("./publish-pending.server.js");
const { reconcileActiveShopDiscountNodes } = await import("./discount-reconciliation.server.js");

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterAll(async () => {
  await close();
});
afterEach(() => {
  vi.useRealTimers();
  waitUntil.mockClear();
  captureException.mockClear();
});

const newShop = () => seedShop(db, `pending-${(counter += 1)}.myshopify.com`);

describe("isLockTimeoutError", () => {
  it("recognises Postgres 55P03 however the driver wraps it", () => {
    expect(isLockTimeoutError(Object.assign(new Error("x"), { code: "55P03" }))).toBe(true);
    expect(isLockTimeoutError(new Error("Failed query", { cause: Object.assign(new Error("y"), { code: "55P03" }) }))).toBe(true);
    expect(isLockTimeoutError(new Error("canceling statement due to lock timeout"))).toBe(true);
    expect(isLockTimeoutError({ cause: { cause: { code: "55P03" } } })).toBe(true);
  });

  it("does not mistake other errors for it", () => {
    expect(isLockTimeoutError(new Error("Shopify 503"))).toBe(false);
    expect(isLockTimeoutError(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(false);
    expect(isLockTimeoutError(null)).toBe(false);
    expect(isLockTimeoutError("lock")).toBe(false);
  });
});

describe("publish-pending flag", () => {
  it("is set by markPublishPending and cleared by a publish that started after it", async () => {
    const shopId = await newShop();
    expect(await isPublishPending(shopId)).toBe(false);

    await markPublishPending(shopId);
    expect(await isPublishPending(shopId)).toBe(true);

    await clearPublishPending(shopId, new Date(Date.now() + 1000));
    expect(await isPublishPending(shopId)).toBe(false);
  });

  it("keeps a flag that was raised after the publish that is finishing began", async () => {
    const shopId = await newShop();
    const startedAt = new Date(Date.now() - 5_000);
    await markPublishPending(shopId); // a newer request, flagged during this publish

    await clearPublishPending(shopId, startedAt);

    expect(await isPublishPending(shopId)).toBe(true);
  });
});

describe("scheduleBackgroundPublishRetry", () => {
  it("retries with backoff until a publish goes through, then stops", async () => {
    vi.useFakeTimers();
    const publish = vi
      .fn<() => Promise<"published" | "pending">>()
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("published");

    const done = scheduleBackgroundPublishRetry("shop", publish, [100, 200, 300]);
    await vi.runAllTimersAsync();
    await done;

    expect(publish).toHaveBeenCalledTimes(2);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("gives up after its attempts and leaves the flag for the cron", async () => {
    vi.useFakeTimers();
    const publish = vi.fn<() => Promise<"published" | "pending">>().mockResolvedValue("pending");

    const done = scheduleBackgroundPublishRetry("shop", publish, [10, 10, 10]);
    await vi.runAllTimersAsync();
    await done;

    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("reports a real failure to Sentry and stops retrying", async () => {
    vi.useFakeTimers();
    const publish = vi.fn<() => Promise<"published" | "pending">>().mockRejectedValue(new Error("Shopify rejected it"));

    const done = scheduleBackgroundPublishRetry("shop", publish, [10, 10, 10]);
    await vi.runAllTimersAsync();
    await done;

    expect(publish).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalled();
  });
});

describe("the offers cron is the backstop for a parked publish", () => {
  it("republishes an active shop flagged publish-pending, and nobody else", async () => {
    const flagged = await newShop();
    const clean = await newShop();
    const inactive = await newShop();
    await db.update(shops).set({ isActive: false }).where(eq(shops.id, inactive));
    await markPublishPending(flagged);
    await markPublishPending(inactive);
    const calls: string[] = [];
    vi.spyOn(await import("./sync/offer-publisher.server.js"), "publishOffersForShop").mockImplementation(async (shopId) => {
      calls.push(shopId);
      return "published";
    });

    const result = await reconcileActiveShopDiscountNodes();

    expect(result.failures).toEqual([]);
    expect(calls).toContain(flagged);
    expect(calls).not.toContain(inactive);
    expect(calls).not.toContain(clean);
  });
});
