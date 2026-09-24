import Redis from "ioredis";

let redis: Redis | null = null;
let connection: Promise<Redis | null> | null = null;

export function isRedisConfigured(): boolean {
  return Boolean(process.env["REDIS_URL"]);
}

export async function getSharedRedis(): Promise<Redis | null> {
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) return null;
  if (redis?.status === "ready") return redis;
  if (connection) return connection;

  if (!redis || redis.status === "end") {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 3_000,
    });
    redis.on("error", () => {
      // Command callers own fallback behavior; avoid unhandled error events.
    });
  }

  const client = redis;
  connection = client.connect()
    .then(() => client)
    .catch(() => {
      client.disconnect(false);
      if (redis === client) redis = null;
      return null;
    })
    .finally(() => {
      connection = null;
    });
  return connection;
}

export function resetSharedRedis(): void {
  redis?.disconnect(false);
  redis = null;
  connection = null;
}
