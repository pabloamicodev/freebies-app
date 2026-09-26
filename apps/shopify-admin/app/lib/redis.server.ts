import Redis from "ioredis";

let redis: Redis | null = null;
let restRedis: RestRedisClient | null = null;
let connection: Promise<SharedRedisClient | null> | null = null;
let lastConnectionError: Error | null = null;

// Circuit breaker: after any Redis failure, skip Redis entirely for a cool-off
// window and fall straight to the DB-backed fallback. Without this, an outage
// meant every request paid Redis's timeout cost (up to REST_TIMEOUT_MS or
// ioredis's connectTimeout) before falling back, on every single request.
const CIRCUIT_BREAKER_MS = 30_000;
const REST_TIMEOUT_MS = 500;
let circuitOpenUntil = 0;

export function recordRedisFailure(): void {
  circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
}

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export interface SharedRedisClient {
  ping(): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  disconnect(): void;
}

interface RestRedisResponse {
  result?: unknown;
  error?: string;
}

class RestRedisClient implements SharedRedisClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  ping(): Promise<unknown> {
    return this.command(["PING"]);
  }

  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    return this.command(["EVAL", script, numberOfKeys, ...args]);
  }

  disconnect(): void {
    // Upstash REST is connectionless, so there is no socket to close.
  }

  private async command(command: Array<string | number>): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = new Error(
        response.status === 401 || response.status === 403
          ? "Redis REST authentication failed"
          : `Redis REST request failed with HTTP ${response.status}`,
      );
      (error as Error & { code: string }).code = `UPSTASH_HTTP_${response.status}`;
      throw error;
    }

    const payload = (await response.json()) as RestRedisResponse;
    if (payload.error) {
      const error = new Error("Redis REST command failed");
      (error as Error & { code: string }).code = "UPSTASH_COMMAND_ERROR";
      throw error;
    }
    if (!("result" in payload)) {
      const error = new Error("Redis REST returned an invalid response");
      (error as Error & { code: string }).code = "UPSTASH_INVALID_RESPONSE";
      throw error;
    }
    return payload.result;
  }
}

function getRestConfig(): { url: string; token: string } | null {
  const pairs = [
    [process.env["UPSTASH_KV_REST_API_URL"], process.env["UPSTASH_KV_REST_API_TOKEN"]],
    [process.env["REDIS_KV_REST_API_URL"], process.env["REDIS_KV_REST_API_TOKEN"]],
    [process.env["UPSTASH_REDIS_REST_URL"], process.env["UPSTASH_REDIS_REST_TOKEN"]],
    [process.env["KV_REST_API_URL"], process.env["KV_REST_API_TOKEN"]],
  ];
  const configured = pairs.find(([url, token]) => Boolean(url && token));
  return configured?.[0] && configured[1] ? { url: configured[0], token: configured[1] } : null;
}

export function isRedisConfigured(): boolean {
  return Boolean(getRestConfig() || process.env["REDIS_URL"]);
}

export async function getSharedRedis(): Promise<SharedRedisClient | null> {
  if (isCircuitOpen()) return null;

  const restConfig = getRestConfig();
  if (restConfig) {
    restRedis ??= new RestRedisClient(restConfig.url, restConfig.token);
    lastConnectionError = null;
    return restRedis;
  }

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
      commandTimeout: REST_TIMEOUT_MS,
    });
    redis.on("error", (error) => {
      // Command callers own fallback behavior; avoid unhandled error events.
      lastConnectionError = sanitizeRedisConnectionError(error);
    });
  }

  const client = redis;
  connection = client
    .connect()
    .then(() => {
      lastConnectionError = null;
      return client;
    })
    .catch((error: unknown) => {
      lastConnectionError = sanitizeRedisConnectionError(error);
      recordRedisFailure();
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
  restRedis?.disconnect();
  redis = null;
  restRedis = null;
  connection = null;
}
