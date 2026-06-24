import { getDb } from "@promo/db";
import { sql } from "drizzle-orm";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

interface RateLimitRow {
  count: number;
  retry_after: number;
}

// DB-backed sliding window — correct across Vercel serverless instances.
// Adds ~3-5ms per call but eliminates the per-instance isolation problem.
export async function checkRateLimit(
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

export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
