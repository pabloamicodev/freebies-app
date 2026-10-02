import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_JOBS, cronsEnabled } from "./cron-run.server.js";

describe("vercel.json crons", () => {
  for (const file of ["../../../../vercel.json", "../../vercel.json"]) {
    it(`${file} lists exactly the registered cron jobs (and no warm cron)`, () => {
      const config = JSON.parse(readFileSync(resolve(__dirname, file), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
      const expected = Object.values(CRON_JOBS).map((job) => `${job.path} ${job.schedule}`).sort();
      expect(config.crons.map((cron) => `${cron.path} ${cron.schedule}`).sort()).toEqual(expected);
    });
  }
});

describe("cronsEnabled (D9)", () => {
  it("keeps current behaviour when nothing is set", () => {
    expect(cronsEnabled({})).toBe(true);
  });
  it("CRONS_ENABLED=false turns a project off, true turns it on", () => {
    expect(cronsEnabled({ CRONS_ENABLED: "false" })).toBe(false);
    expect(cronsEnabled({ CRONS_ENABLED: "0" })).toBe(false);
    expect(cronsEnabled({ CRONS_ENABLED: "true" })).toBe(true);
  });
  it("honours the CRONS_DISABLED and legacy DISABLE_CRONS opt-outs", () => {
    expect(cronsEnabled({ CRONS_DISABLED: "true" })).toBe(false);
    expect(cronsEnabled({ DISABLE_CRONS: "1" })).toBe(false);
  });
});

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  checkIn: vi.fn(() => "check-in-id"),
}));
vi.mock("./redis.server.js", () => ({ redisAcquireLock: mocks.acquire, redisReleaseLock: mocks.release }));
vi.mock("@sentry/node", () => ({ captureCheckIn: mocks.checkIn, flush: vi.fn(async () => true), captureException: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@promo/db", () => ({ getDb: () => ({ execute: vi.fn(async () => []) }) }));

describe("runCron", () => {
  const request = () => new Request("https://app.test/api/cron/x", { headers: { authorization: "Bearer s3cret" } });
  beforeEach(() => {
    process.env["CRON_SECRET"] = "s3cret";
    mocks.acquire.mockReset().mockResolvedValue(true);
    mocks.release.mockReset().mockResolvedValue(undefined);
    mocks.checkIn.mockClear();
  });
  afterEach(() => {
    delete process.env["CRON_SECRET"];
    delete process.env["CRONS_ENABLED"];
  });

  it("skips without running or checking in when crons are disabled on this project", async () => {
    process.env["CRONS_ENABLED"] = "false";
    const { runCron } = await import("./cron-run.server.js");
    const run = vi.fn();
    const response = await runCron(request(), "gift-stock", run);
    expect(await response.json()).toMatchObject({ skipped: "crons_disabled" });
    expect(run).not.toHaveBeenCalled();
    expect(mocks.checkIn).not.toHaveBeenCalled();
  });

  it("does not run when another invocation holds the lock", async () => {
    mocks.acquire.mockResolvedValue(false);
    const { runCron } = await import("./cron-run.server.js");
    const run = vi.fn();
    const response = await runCron(request(), "skio-shipping", run);
    expect(await response.json()).toMatchObject({ skipped: "already_running" });
    expect(run).not.toHaveBeenCalled();
  });

  it("checks in ok, releases the lock, and reports failure as error", async () => {
    const { runCron } = await import("./cron-run.server.js");
    await runCron(request(), "gift-stock", async () => ({ body: { ok: true } }));
    expect(mocks.checkIn).toHaveBeenLastCalledWith(expect.objectContaining({ monitorSlug: "cron-gift-stock", status: "ok" }));
    await runCron(request(), "gift-stock", async () => ({ body: { ok: false }, status: 207 }));
    expect(mocks.checkIn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("returns 500 and an error check-in when the job throws, still releasing the lock", async () => {
    const { runCron } = await import("./cron-run.server.js");
    const response = await runCron(request(), "offers", async () => {
      throw new Error("db down");
    });
    expect(response.status).toBe(500);
    expect(mocks.checkIn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
    expect(mocks.release).toHaveBeenCalled();
  });
});

describe("cron route config", () => {
  it.each(Object.entries(CRON_JOBS))("%s route exports the literal maxDuration registered in CRON_JOBS", (name, job) => {
    const source = readFileSync(resolve(__dirname, `../routes/api.cron.${name}.ts`), "utf8");
    expect(source).toContain(`export const config = { maxDuration: ${job.maxDuration} };`);
  });
});
