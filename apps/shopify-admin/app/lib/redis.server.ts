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

// Primary Upstash quota exhausted: serve from the backup instance until this passes, then probe primary again.
// Short rate/daily limits block for 10 min; the monthly free-tier quota blocks until the next month starts
// (UTC), capped at 24h so a failed probe costs at most one rejected command per instance per day.
// State is per-process on purpose: a probe against an exhausted primary isn't billed, whereas a flag shared
// via Redis would cost a command on every cold start.
const PRIMARY_EXHAUSTED_MS = 10 * 60_000;
const MONTHLY_PROBE_MS = 24 * 3_600_000;
const QUOTA_PATTERN = /max.*(request|command|daily|monthly).*limit|limit exceeded|quota/i;
const MONTHLY_QUOTA_PATTERN = /max requests limit exceeded|monthly|quota/i;
const QUOTA_CODE = "UPSTASH_QUOTA_EXHAUSTED";
const MONTHLY_QUOTA_CODE = "UPSTASH_MONTHLY_QUOTA_EXHAUSTED";
let primaryExhaustedUntil = 0;

function blockPrimary(monthly: boolean): void {
  const now = Date.now();
  if (!monthly) {
    primaryExhaustedUntil = now + PRIMARY_EXHAUSTED_MS;
    return;
  }
  const d = new Date(now);
  const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  primaryExhaustedUntil = Math.min(nextMonthStart, now + MONTHLY_PROBE_MS);
}

export function getRedisPrimaryBlockedUntil(): string | null {
  return getBackupRestConfig() && Date.now() < primaryExhaustedUntil
    ? new Date(primaryExhaustedUntil).toISOString()
    : null;
}

export function getRedisActiveInstance(): "primary" | "backup" {
  return getBackupRestConfig() && Date.now() < primaryExhaustedUntil ? "backup" : "primary";
}

export function recordRedisFailure(): void {
  circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
}

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export interface SharedRedisClient {
  ping(): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** Plain command (GET/SET/DEL...): billed once, unlike the same command wrapped in EVAL. */
  command(args: Array<string | number>): Promise<unknown>;
  disconnect(): void;
}

interface RestRedisResponse {
  result?: unknown;
  error?: string;
}

interface RestConfig {
  url: string;
  token: string;
}

class RestRedisClient implements SharedRedisClient {
  constructor(
    private readonly primary: RestConfig,
    private readonly backup: RestConfig | null,
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

  async command(command: Array<string | number>): Promise<unknown> {
    if (!this.backup) return this.send(this.primary, command);
    if (Date.now() < primaryExhaustedUntil) return this.send(this.backup, command);
    try {
      return await this.send(this.primary, command);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code !== QUOTA_CODE && code !== MONTHLY_QUOTA_CODE) throw error;
      blockPrimary(code === MONTHLY_QUOTA_CODE);
      return this.send(this.backup, command);
    }
  }

  private async send({ url, token }: RestConfig, command: Array<string | number>): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const isQuota = response.status === 429 || QUOTA_PATTERN.test(body);
      const error = new Error(
        isQuota
          ? "Redis REST quota exhausted"
          : response.status === 401 || response.status === 403
            ? "Redis REST authentication failed"
            : `Redis REST request failed with HTTP ${response.status}`,
      );
      (error as Error & { code: string }).code = isQuota
        ? MONTHLY_QUOTA_PATTERN.test(body)
          ? MONTHLY_QUOTA_CODE
          : QUOTA_CODE
        : `UPSTASH_HTTP_${response.status}`;
      throw error;
    }

    const payload = (await response.json()) as RestRedisResponse;
    if (payload.error) {
      const isQuota = QUOTA_PATTERN.test(payload.error);
      const error = new Error(isQuota ? "Redis REST quota exhausted" : "Redis REST command failed");
      (error as Error & { code: string }).code = isQuota
        ? MONTHLY_QUOTA_PATTERN.test(payload.error)
          ? MONTHLY_QUOTA_CODE
          : QUOTA_CODE
        : "UPSTASH_COMMAND_ERROR";
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

function getBackupRestConfig(): RestConfig | null {
  const url = process.env["BACKUP_KV_REST_API_URL"];
  const token = process.env["BACKUP_KV_REST_API_TOKEN"];
  return url && token ? { url, token } : null;
}

function getRestConfig(): RestConfig | null {
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

// ioredis already has an unrelated `command()` (COMMAND INFO), so it cannot implement the interface directly.
function adaptIoredis(client: Redis): SharedRedisClient {
  return {
    ping: () => client.ping(),
    eval: (script, numberOfKeys, ...args) => client.eval(script, numberOfKeys, ...args),
    command: ([name, ...args]) => client.call(String(name), ...args.map(String)),
    disconnect: () => client.disconnect(),
  };
}

export async function getSharedRedis(): Promise<SharedRedisClient | null> {
  if (isCircuitOpen()) return null;

  const restConfig = getRestConfig();
  if (restConfig) {
    restRedis ??= new RestRedisClient(restConfig, getBackupRestConfig());
    lastConnectionError = null;
    return restRedis;
  }

  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    lastConnectionError = null;
    return null;
  }
  if (redis?.status === "ready") return adaptIoredis(redis);
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
      return adaptIoredis(client);
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

// ─── Small key/value helpers (best-effort cache + locks) ──────────────────────
// All return null/false on any Redis problem so callers fall back to the DB.

async function redisEval(script: string, key: string, ...args: Array<string | number>): Promise<unknown> {
  const client = await getSharedRedis();
  if (!client) return null;
  try {
    return await client.eval(script, 1, key, ...args);
  } catch {
    recordRedisFailure();
    resetSharedRedis();
    return null;
  }
}

async function redisCommand(...args: Array<string | number>): Promise<unknown> {
  const client = await getSharedRedis();
  if (!client) return null;
  try {
    return await client.command(args);
  } catch {
    recordRedisFailure();
    resetSharedRedis();
    return null;
  }
}

export async function redisGetString(key: string): Promise<string | null> {
  const value = await redisCommand("GET", key);
  return typeof value === "string" ? value : null;
}

export async function redisSetString(key: string, value: string, ttlSeconds: number): Promise<void> {
  await redisCommand("SET", key, value, "EX", ttlSeconds);
}

export async function redisDelete(key: string): Promise<void> {
  await redisCommand("DEL", key);
}

/** SET NX PX. true = acquired, false = held elsewhere, null = Redis unavailable. */
export async function redisAcquireLock(key: string, token: string, ttlMs: number): Promise<boolean | null> {
  const result = await redisEval(
    "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end",
    key,
    token,
    ttlMs,
  );
  return result === null ? null : Number(result) === 1;
}

export async function redisReleaseLock(key: string, token: string): Promise<void> {
  await redisEval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", key, token);
}

/** Fixed-window counter: O(1) per call, for high-volume limits where a sorted set per window is too heavy. */
export async function redisIncrWindow(key: string, windowSeconds: number): Promise<number | null> {
  const result = await redisEval(
    "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c",
    key,
    windowSeconds,
  );
  return result === null ? null : Number(result);
}
