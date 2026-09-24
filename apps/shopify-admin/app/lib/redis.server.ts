import Redis from "ioredis";

let redis: Redis | null = null;
let connection: Promise<Redis | null> | null = null;
let lastConnectionError: Error | null = null;

export function isRedisConfigured(): boolean {
  return Boolean(process.env["REDIS_URL"]);
}

export async function getSharedRedis(): Promise<Redis | null> {
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    lastConnectionError = null;
    return null;
  }
  if (redis?.status === "ready") return redis;
  if (connection) return connection;

  if (!redis || redis.status === "end") {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3_000,
    });
    redis.on("error", (error) => {
      // Command callers own fallback behavior; avoid unhandled error events.
      lastConnectionError = sanitizeRedisConnectionError(error);
    });
  }

  const client = redis;
  connection = client.connect()
    .then(() => {
      lastConnectionError = null;
      return client;
    })
    .catch((error: unknown) => {
      lastConnectionError = sanitizeRedisConnectionError(error);
      client.disconnect(false);
      if (redis === client) redis = null;
      return null;
    })
    .finally(() => {
      connection = null;
    });
  return connection;
}

export function getLastRedisConnectionError(): Error | null {
  return lastConnectionError;
}

export function sanitizeRedisConnectionError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const sanitized = new Error(
    source.message
      .replace(/rediss?:\/\/[^\s]+/gi, "redis://[redacted]")
      .replace(/\/\/[^:@/\s]+:[^@/\s]+@/g, "//[redacted]@"),
  );
  sanitized.name = source.name;
  const code = (source as Error & { code?: unknown }).code;
  if (code !== undefined) {
    (sanitized as Error & { code?: unknown }).code = code;
  }
  return sanitized;
}

export function resetSharedRedis(): void {
  redis?.disconnect(false);
  redis = null;
  connection = null;
}
