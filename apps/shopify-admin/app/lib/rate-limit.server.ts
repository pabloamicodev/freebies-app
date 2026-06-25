import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

interface RateLimitRow extends Record<string, unknown> {
  count: number;
  retry_after: number;
}

// In-memory first-tier: eliminates DB round-trip for well-behaved traffic.
// Falls through to DB for enforcement near/over the limit — keeps cross-instance
// correctness while removing the hot-path write cost.
interface MemBucket { count: number; windowStart: number; }
const memCounters = new Map<string, MemBucket>();
const MEM_BYPASS_RATIO = 0.7; // skip DB when count < 70% of limit

function getMemCount(key: string, windowMs: number): number {
  const now = Date.now();
  const bucket = memCounters.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    memCounters.set(key, { count: 1, windowStart: now });
    return 1;
  }
  bucket.count += 1;
  return bucket.count;
}

// DB-backed sliding window — correct across Vercel serverless instances.
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const memCount = getMemCount(key, options.windowMs);
  // Fast-path: well under limit — skip DB entirely.
  if (memCount < Math.floor(options.limit * MEM_BYPASS_RATIO)) return { ok: true };

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

export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
