import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";
import { getSharedRedis, recordRedisFailure, redisIncrWindow, resetSharedRedis } from "./redis.server.js";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** O(1) INCR per window instead of a sorted set: use for high caps (shop-wide). Allows up to 2x burst at a window edge. */
  fixedWindow?: boolean;
  /**
   * What to do when Redis is unavailable. "db" (default) uses the `rate_limits` table. "skip" allows the request:
   * use it for shop-wide caps, where every request would otherwise upsert the same hot row and Redis being down
   * would turn into a Neon outage. "memory" counts per instance (a weaker but free limit).
   */
  onRedisUnavailable?: "db" | "skip" | "memory";
}

/** Positive integer from the environment, read at call time so a redeploy-free test or override works. */
export function envLimit(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Math.floor(Number(env[name]));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Retry-After for a 429, spread over a few seconds so shed clients do not all come back on the same tick
 * (a fixed window resets for everyone at once). Clients should wait at least this long.
 */
export function jitteredRetryAfter(seconds: number, random: () => number = Math.random): number {
  const base = Math.max(1, Math.ceil(seconds));
  return base + Math.floor(random() * Math.min(10, base + 1));
}

const memoryWindows = new Map<string, { count: number; resetAt: number }>();

function memoryCheckRateLimit(key: string, options: RateLimitOptions): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  if (memoryWindows.size > 5_000) {
    for (const [name, entry] of memoryWindows) if (entry.resetAt <= now) memoryWindows.delete(name);
  }
  let entry = memoryWindows.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + options.windowMs };
    memoryWindows.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= options.limit ? { ok: true } : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

export function resetMemoryRateLimits(): void {
  memoryWindows.clear();
}

interface RateLimitRow extends Record<string, unknown> {
  count: number;
  retry_after: number;
}

// Sliding window via a sorted set. Atomically counts requests in the window.
// Returns null on any Redis error — caller falls through to DB.
async function redisCheckRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number } | null> {
  const redis = await getSharedRedis();
  if (!redis) return null;

  const windowSeconds = Math.ceil(options.windowMs / 1000);
  const now = Date.now(); // ms
  const windowStart = now - options.windowMs;
  const redisKey = `rl:${key}`;

  // Lua: remove expired members, add current request, count remaining.
  // seq key prevents collisions when two requests arrive at the exact same ms.
  const LUA = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local windowStart = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
    local seq = redis.call('INCR', key .. ':seq')
    redis.call('ZADD', key, now, now .. '-' .. seq)
    local count = redis.call('ZCARD', key)
    redis.call('EXPIRE', key, ttl)
    redis.call('EXPIRE', key .. ':seq', ttl)
    return count
  `;

  try {
    const count = (await redis.eval(LUA, 1, redisKey, now, windowStart, windowSeconds + 1)) as number;
    if (count <= options.limit) return { ok: true };
    return { ok: false, retryAfterSeconds: windowSeconds };
  } catch {
    recordRedisFailure();
    resetSharedRedis();
    return null;
  }
}

// ─── DB-backed sliding window (fallback when Redis is absent or unhealthy) ────

async function redisFixedWindow(
  key: string,
  options: RateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number } | null> {
  const now = Date.now();
  const window = Math.floor(now / options.windowMs);
  const count = await redisIncrWindow(`rlf:${key}:${window}`, Math.ceil(options.windowMs / 1000) + 1);
  if (count === null) return null;
  if (count <= options.limit) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * options.windowMs - now) / 1000)) };
}

async function dbCheckRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const windowSeconds = Math.ceil(options.windowMs / 1000);
  const db = getDb();

  const rows = await db.execute<RateLimitRow>(sql`
    INSERT INTO rate_limits (key, count, window_start, updated_at)
    VALUES (${key}, 1, NOW(), NOW())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start < NOW() - (${windowSeconds}::text || ' seconds')::interval
          THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start < NOW() - (${windowSeconds}::text || ' seconds')::interval
          THEN NOW()
        ELSE rate_limits.window_start
      END,
      updated_at = NOW()
    RETURNING
      count,
      GREATEST(0,
        EXTRACT(EPOCH FROM (window_start + (${windowSeconds}::text || ' seconds')::interval - NOW()))::int
      ) AS retry_after
  `);

  const row = rows[0];
  if (!row || row.count <= options.limit) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, row.retry_after) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  // Every request must hit a shared enforcement tier. Per-instance counters can
  // be bypassed by spreading traffic across serverless instances.
  const redisResult = options.fixedWindow ? await redisFixedWindow(key, options) : await redisCheckRateLimit(key, options);
  if (redisResult !== null) return redisResult;

  if (options.onRedisUnavailable === "skip") return { ok: true };
  if (options.onRedisUnavailable === "memory") return memoryCheckRateLimit(key, options);
  return dbCheckRateLimit(key, options);
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
