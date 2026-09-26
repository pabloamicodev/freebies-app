import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";
import { getSharedRedis, recordRedisFailure, resetSharedRedis } from "./redis.server.js";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
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
  const redisResult = await redisCheckRateLimit(key, options);
  if (redisResult !== null) return redisResult;

  return dbCheckRateLimit(key, options);
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
