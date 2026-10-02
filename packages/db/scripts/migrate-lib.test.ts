import { describe, expect, it, vi } from "vitest";
import { diffMigrationJournal, isTransientMigrationError, resolveMigrationSettings, retryTransient, runLockedWithRetry } from "./migrate-lib.js";

describe("resolveMigrationSettings", () => {
  it("refuses the pooled URL as a fallback for a remote database", () => {
    expect(() => resolveMigrationSettings({ DATABASE_URL: "postgres://u:p@ep-x-pooler.neon.tech/db" })).toThrow(/UNPOOLED/);
    expect(() => resolveMigrationSettings({})).toThrow(/UNPOOLED/);
  });
  it("uses the unpooled URL and defaults to a 5s lock_timeout", () => {
    const s = resolveMigrationSettings({ DATABASE_URL_UNPOOLED: "postgres://u:p@ep-x.neon.tech/db", DATABASE_URL: "postgres://pooled" });
    expect(s.url).toContain("ep-x.neon.tech");
    expect(s.lockTimeoutMs).toBe(5_000);
    expect(s.statementTimeoutMs).toBeGreaterThan(0);
  });
  it("allows DATABASE_URL for a local database only", () => {
    expect(resolveMigrationSettings({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }).url).toContain("localhost");
  });
  it("honours env overrides", () => {
    expect(resolveMigrationSettings({ DATABASE_URL_UNPOOLED: "postgres://x", MIGRATION_LOCK_TIMEOUT_MS: "9000" }).lockTimeoutMs).toBe(9000);
  });
});

describe("retryTransient", () => {
  const lockError = Object.assign(new Error("lock"), { code: "55P03" });
  it("classifies lock and statement timeouts as transient", () => {
    expect(isTransientMigrationError(lockError)).toBe(true);
    expect(isTransientMigrationError(Object.assign(new Error("x"), { code: "57014" }))).toBe(true);
    expect(isTransientMigrationError(Object.assign(new Error("x"), { code: "42P01" }))).toBe(false);
    expect(isTransientMigrationError(new Error("plain"))).toBe(false);
  });
  it("retries transient failures with backoff then succeeds", async () => {
    const run = vi.fn().mockRejectedValueOnce(lockError).mockRejectedValueOnce(lockError).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retryTransient(run, { attempts: 4, sleep })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2_000, 4_000]);
  });
  it("does not retry a permanent error and stops after the last attempt", async () => {
    const permanent = Object.assign(new Error("syntax"), { code: "42601" });
    const run = vi.fn().mockRejectedValue(permanent);
    await expect(retryTransient(run, { attempts: 4, sleep: async () => undefined })).rejects.toBe(permanent);
    expect(run).toHaveBeenCalledTimes(1);
    const always = vi.fn().mockRejectedValue(lockError);
    await expect(retryTransient(always, { attempts: 2, sleep: async () => undefined })).rejects.toBe(lockError);
    expect(always).toHaveBeenCalledTimes(2);
  });
});

describe("diffMigrationJournal", () => {
  const journal = [
    { idx: 0, tag: "0016_a", when: 100, hash: "h16" },
    { idx: 1, tag: "0017_b", when: 200, hash: "h17" },
    { idx: 2, tag: "0018_c", when: 300, hash: "h18" },
  ];
  it("reports migrations that are not applied", () => {
    const r = diffMigrationJournal(journal, [{ createdAt: 100, hash: "h16" }, { createdAt: 200, hash: "h17" }]);
    expect(r.missing).toEqual(["0018_c"]);
    expect(r.hashMismatch).toEqual([]);
  });
  it("reports edited files and unknown applied rows", () => {
    const r = diffMigrationJournal(journal, [
      { createdAt: 100, hash: "h16" },
      { createdAt: 200, hash: "CHANGED" },
      { createdAt: 300, hash: "h18" },
      { createdAt: 999, hash: "x" },
    ]);
    expect(r.hashMismatch).toEqual(["0017_b"]);
    expect(r.unknown).toEqual([999]);
  });
});

describe("runLockedWithRetry", () => {
  const connectionLost = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const opts = { attempts: 4, sleep: async () => undefined };

  it("takes the advisory lock again before every attempt, so a dropped connection never migrates unlocked", async () => {
    const events: string[] = [];
    const acquire = vi.fn(async () => void events.push("lock"));
    const run = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => {
        events.push("run");
        throw connectionLost;
      })
      .mockImplementationOnce(async () => {
        events.push("run");
        return "done";
      });
    await expect(runLockedWithRetry(acquire, run, opts)).resolves.toBe("done");
    expect(events).toEqual(["lock", "run", "lock", "run"]);
  });

  it("does not retry (or re-lock) after a permanent error", async () => {
    const acquire = vi.fn(async () => undefined);
    const permanent = Object.assign(new Error("syntax"), { code: "42601" });
    await expect(runLockedWithRetry(acquire, async () => Promise.reject(permanent), opts)).rejects.toBe(permanent);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("retries when re-acquiring the lock itself hits a connection error", async () => {
    const acquire = vi.fn().mockRejectedValueOnce(connectionLost).mockResolvedValue(undefined);
    const run = vi.fn(async () => "ok");
    await expect(runLockedWithRetry(acquire, run, opts)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
