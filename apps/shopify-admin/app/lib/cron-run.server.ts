import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@promo/db";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";
import { isCronRequestAuthorized } from "./cron-auth.server.js";
import { apiError, apiJson, handleApiError } from "./api-response.server.js";
import { redisAcquireLock, redisReleaseLock } from "./redis.server.js";

/**
 * Single source for cron schedules. vercel.json (both copies) must list exactly these;
 * cron-config.test.ts enforces it. `maxDuration` is exported by each route as
 * `config` and doubles as the lock TTL, so a crashed run can never block the next one for longer.
 */
export const CRON_JOBS = {
  offers: { path: "/api/cron/offers", schedule: "*/5 * * * *", maxDuration: 300 },
  "catalog-sync": { path: "/api/cron/catalog-sync", schedule: "* * * * *", maxDuration: 60 },
  "gift-stock": { path: "/api/cron/gift-stock", schedule: "*/10 * * * *", maxDuration: 300 },
  "skio-shipping": { path: "/api/cron/skio-shipping", schedule: "*/15 * * * *", maxDuration: 300 },
  "analytics-cleanup": { path: "/api/cron/analytics-cleanup", schedule: "0 3 * * *", maxDuration: 60 },
} as const;

export type CronName = keyof typeof CRON_JOBS;

/**
 * D9: crons run in one Vercel project. Both projects deploy the same vercel.json, so the
 * non-owning project must opt out. Unset keeps today's behaviour (enabled) so nothing
 * changes until the flags are set (docs/RUNBOOK.md, "Cron ownership").
 */
export function cronsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env["CRONS_ENABLED"]?.trim();
  if (enabled) return !/^(0|false|no|off)$/i.test(enabled);
  const disabled = (name: string) => /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? "");
  return !(disabled("CRONS_DISABLED") || disabled("DISABLE_CRONS"));
}

/** Per Vercel project (VERCEL_PROJECT_ID, or CRON_PROJECT to name it by hand), so one project's stuck lock never blocks the other's. */
export function cronLockKey(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const project = env["VERCEL_PROJECT_ID"]?.trim() || env["CRON_PROJECT"]?.trim() || "default";
  return `cron-lock:${project}:${name}`;
}

async function acquireDbLock(key: string, ttlMs: number): Promise<boolean> {
  const rows = await getDb().execute(sql`
    INSERT INTO rate_limits (key, count, window_start, updated_at)
    VALUES (${key}, 1, NOW(), NOW())
    ON CONFLICT (key) DO UPDATE SET window_start = NOW(), updated_at = NOW()
    WHERE rate_limits.window_start < NOW() - (${Math.ceil(ttlMs / 1000)}::text || ' seconds')::interval
    RETURNING key
  `);
  return rows.length > 0;
}

async function releaseDbLock(key: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
}

/** Overlap guard. Redis first, `rate_limits` row as fallback; fails open if neither is reachable. */
export async function acquireCronLock(name: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const key = cronLockKey(name);
  const token = randomUUID();
  try {
    const viaRedis = await redisAcquireLock(key, token, ttlMs);
    if (viaRedis === true) return () => redisReleaseLock(key, token);
    if (viaRedis === false) return null;
    if (await acquireDbLock(key, ttlMs)) return () => releaseDbLock(key).catch(() => undefined);
    return null;
  } catch (error) {
    console.warn(`[cron:${name}] lock unavailable, running without it`, error instanceof Error ? error.message : error);
    return async () => undefined;
  }
}

export interface CronOutcome {
  body: Record<string, unknown>;
  /** Non-2xx (e.g. 207 partial failure) marks the Sentry check-in as failed. */
  status?: number;
}

/**
 * Wraps every cron route: D9 gate, auth, overlap lock, Sentry cron monitor check-ins,
 * and error capture (handleApiError reports to Sentry).
 */
export async function runCron(request: Request, name: CronName, run: () => Promise<CronOutcome>): Promise<Response> {
  if (!cronsEnabled()) return apiJson(request, { ok: true, skipped: "crons_disabled" });
  if (!isCronRequestAuthorized(request)) {
    return apiError(request, { status: 401, code: "UNAUTHORIZED", message: "Unauthorized." });
  }

  const job = CRON_JOBS[name];
  const release = await acquireCronLock(name, job.maxDuration * 1000);
  if (!release) return apiJson(request, { ok: true, skipped: "already_running" });

  const monitorConfig = {
    schedule: { type: "crontab" as const, value: job.schedule },
    // Check-in margin and max runtime (minutes) tolerate Vercel's cron jitter and a full-length run.
    checkinMargin: 5,
    maxRuntime: Math.ceil(job.maxDuration / 60) + 1,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
  };
  const checkInId = Sentry.captureCheckIn({ monitorSlug: `cron-${name}`, status: "in_progress" }, monitorConfig);
  const startedAt = Date.now();
  const finish = (status: "ok" | "error") => {
    Sentry.captureCheckIn({ monitorSlug: `cron-${name}`, status, checkInId, duration: (Date.now() - startedAt) / 1000 });
    waitUntil(Sentry.flush(2000));
  };

  try {
    const outcome = await run();
    const failed = (outcome.status ?? 200) >= 300 || outcome.body["ok"] === false;
    finish(failed ? "error" : "ok");
    return apiJson(request, outcome.body, { status: outcome.status ?? 200 });
  } catch (error) {
    finish("error");
    return handleApiError(request, error, `cron.${name}`);
  } finally {
    await release();
  }
}
