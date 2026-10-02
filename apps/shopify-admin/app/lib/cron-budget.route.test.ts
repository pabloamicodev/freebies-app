import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./redis.server.js", () => ({
  redisAcquireLock: vi.fn(async () => true),
  redisReleaseLock: vi.fn(async () => undefined),
}));
vi.mock("@promo/db", () => ({ getDb: () => ({ execute: vi.fn(async () => []) }) }));
const drainProductSyncQueue = vi.fn();
const drainCatalogRefreshQueue = vi.fn();
vi.mock("./sync/product-sync.server.js", () => ({ drainProductSyncQueue }));
vi.mock("./sync/inventory-sync-queue.server.js", () => ({ drainCatalogRefreshQueue }));

const { loader } = await import("../routes/api.cron.catalog-sync.js");
const { cronLockKey, CRON_JOBS } = await import("./cron-run.server.js");
const { redisAcquireLock } = await import("./redis.server.js");

const call = () =>
  loader({
    request: new Request("https://app.test/api/cron/catalog-sync", { headers: { authorization: "Bearer s3cret" } }),
    params: {},
    context: {},
  } as never);

beforeEach(() => {
  process.env["CRON_SECRET"] = "s3cret";
  delete process.env["CRONS_ENABLED"];
  drainProductSyncQueue.mockReset().mockResolvedValue({ steps: 1 });
  drainCatalogRefreshQueue.mockReset().mockResolvedValue({ claimed: 0, completed: 0, failed: 0 });
});

describe("catalog-sync drain budget", () => {
  it("keeps both drains inside 50 s of wall time in total (maxDuration is 60 s)", async () => {
    vi.useFakeTimers();
    try {
      // Each drain uses its whole budget, the worst case.
      drainProductSyncQueue.mockImplementation(async (options: { maxRuntimeMs: number }) => {
        vi.advanceTimersByTime(options.maxRuntimeMs);
        return { steps: 6 };
      });
      drainCatalogRefreshQueue.mockImplementation(async (options: { maxRuntimeMs: number }) => {
        vi.advanceTimersByTime(options.maxRuntimeMs);
        return { claimed: 0, completed: 0, failed: 0 };
      });
      const startedAt = Date.now();
      await call();
      expect(CRON_JOBS["catalog-sync"].maxDuration).toBe(60);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(50_000);
      expect(drainProductSyncQueue.mock.calls[0]![0].maxRuntimeMs).toBeGreaterThan(0);
      expect(drainCatalogRefreshQueue.mock.calls[0]![0].maxRuntimeMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the refresh drain only what the first one left, and skips it when nothing is left", async () => {
    vi.useFakeTimers();
    try {
      drainProductSyncQueue.mockImplementation(async () => {
        vi.advanceTimersByTime(49_500);
        return { steps: 6 };
      });
      const response = await call();
      expect(drainCatalogRefreshQueue).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true, refresh: { skipped: "budget_spent" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cron lock key", () => {
  it("includes the Vercel project so projects never share a lock", () => {
    expect(cronLockKey("offers", { VERCEL_PROJECT_ID: "prj_ambrosia" })).toBe("cron-lock:prj_ambrosia:offers");
    expect(cronLockKey("offers", { VERCEL_PROJECT_ID: "prj_hpn" })).not.toBe(cronLockKey("offers", { VERCEL_PROJECT_ID: "prj_ambrosia" }));
    expect(cronLockKey("offers", { CRON_PROJECT: "ambrosia" })).toBe("cron-lock:ambrosia:offers");
    expect(cronLockKey("offers", {})).toBe("cron-lock:default:offers");
  });

  it("is the key runCron actually locks on", async () => {
    process.env["VERCEL_PROJECT_ID"] = "prj_test";
    try {
      await call();
      expect(vi.mocked(redisAcquireLock).mock.calls.at(-1)![0]).toBe("cron-lock:prj_test:catalog-sync");
    } finally {
      delete process.env["VERCEL_PROJECT_ID"];
    }
  });
});
