import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reconcile = vi.fn();
vi.mock("./redis.server.js", () => ({
  redisAcquireLock: vi.fn(async () => true),
  redisReleaseLock: vi.fn(async () => undefined),
}));
vi.mock("@promo/db", () => ({ getDb: () => ({ execute: vi.fn(async () => []) }) }));
vi.mock("./sync/gift-stock-reconcile.server.js", () => ({ reconcileAllShopsGiftVariants: reconcile }));

const { loader } = await import("../routes/api.cron.gift-stock.js");

const call = (headers: Record<string, string> = {}) =>
  loader({ request: new Request("https://app.test/api/cron/gift-stock", { headers }), params: {}, context: {} } as never);

beforeEach(() => {
  process.env["CRON_SECRET"] = "s3cret";
  delete process.env["DISABLE_CRONS"];
  delete process.env["CRONS_ENABLED"];
  reconcile.mockReset();
});
afterEach(() => {
  delete process.env["CRON_SECRET"];
  delete process.env["DISABLE_CRONS"];
});

describe("/api/cron/gift-stock", () => {
  it("rejects requests without the cron secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects everything when no secret is configured or crons are disabled on this deployment", async () => {
    delete process.env["CRON_SECRET"];
    expect((await call({ authorization: "Bearer s3cret" })).status).toBe(401);
    process.env["CRON_SECRET"] = "s3cret";
    process.env["CRONS_ENABLED"] = "false";
    const skipped = await call({ authorization: "Bearer s3cret" });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ skipped: "crons_disabled" });
    delete process.env["CRONS_ENABLED"];
    process.env["DISABLE_CRONS"] = "1";
    expect((await call({ authorization: "Bearer s3cret" })).status).toBe(200);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs the reconcile with the bearer secret and reports counts", async () => {
    reconcile.mockResolvedValue({ shops: 2, changed: 3, failed: 0 });
    const response = await call({ authorization: "Bearer s3cret" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, shops: 2, changed: 3, failed: 0 });
  });

  it("accepts the x-vercel-cron-secret header too", async () => {
    reconcile.mockResolvedValue({ shops: 0, changed: 0, failed: 0 });
    expect((await call({ "x-vercel-cron-secret": "s3cret" })).status).toBe(200);
  });

  it("flags partial failure (a shop errored or was throttled out) instead of reporting ok", async () => {
    reconcile.mockResolvedValue({ shops: 2, changed: 0, failed: 1 });
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(body).toMatchObject({ ok: false, failed: 1 });
  });

  it("returns a server error when the reconcile itself blows up", async () => {
    reconcile.mockRejectedValue(new Error("db down"));
    expect((await call({ authorization: "Bearer s3cret" })).status).toBeGreaterThanOrEqual(500);
  });
});
