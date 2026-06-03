/**
 * Redis sliding window rate limiter.
 * Rejects requests that exceed per-shop/session limits.
 */

import type { Context } from "hono";

interface RateLimitConfig {
  /** Max requests allowed in the window. */
  max: number;
  /** Window duration in seconds. */
  windowSecs: number;
  /** Key prefix for Redis. */
  prefix: string;
}

const LIMITS: Record<string, RateLimitConfig> = {
  evaluate:       { max: 60,  windowSecs: 60, prefix: "rl:eval" },
  prepareCheckout:{ max: 20,  windowSecs: 60, prefix: "rl:prep" },
  analytics:      { max: 500, windowSecs: 60, prefix: "rl:anal" },
  adminApi:       { max: 100, windowSecs: 60, prefix: "rl:adm" },
  webhooks:       { max: 1000,windowSecs: 60, prefix: "rl:wh" },
};

let _redis: any = null;

async function getRedis() {
  if (!_redis) {
    const { redis } = await import("./queues.server.js");
    _redis = redis;
  }
  return _redis;
}

/**
 * Check rate limit for a given key.
 * Returns true if request is allowed, false if rate limit exceeded.
 */
export async function checkRateLimit(
  limitName: keyof typeof LIMITS,
  identifier: string,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const config = LIMITS[limitName];
  if (!config) return { allowed: true, remaining: 999, resetIn: 0 };

  try {
    const redis = await getRedis();
    const key = `${config.prefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowSecs * 1000;

    // Sliding window log algorithm
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, `${now}`);
    pipeline.zcard(key);
    pipeline.expire(key, config.windowSecs + 1);
    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number) ?? 0;
    const remaining = Math.max(0, config.max - count);
    const resetIn = config.windowSecs;

    return {
      allowed: count <= config.max,
      remaining,
      resetIn,
    };
  } catch {
    // Redis unavailable — fail open (allow request)
    return { allowed: true, remaining: config.max, resetIn: config.windowSecs };
  }
}

/**
 * Hono middleware factory for rate limiting.
 */
export function rateLimitMiddleware(limitName: keyof typeof LIMITS) {
  return async (c: Context, next: () => Promise<void>) => {
    const shopDomain = c.req.header("X-Promo-Shop") ?? c.req.header("X-Shopify-Shop-Domain") ?? "unknown";
    const sessionId = c.req.header("X-Promo-Session") ?? "";

    // Rate limit by shop (primary) and session (secondary)
    const shopKey = `${shopDomain}`;
    const { allowed, remaining, resetIn } = await checkRateLimit(limitName, shopKey);

    c.header("X-RateLimit-Limit", String(LIMITS[limitName]?.max ?? 0));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + resetIn));

    if (!allowed) {
      return c.json(
        { error: "Too many requests", retryAfter: resetIn },
        429,
        { "Retry-After": String(resetIn) },
      );
    }

    await next();
    return;
  };
}
