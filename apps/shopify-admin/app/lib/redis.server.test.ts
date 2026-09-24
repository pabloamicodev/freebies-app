import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSharedRedis,
  isRedisConfigured,
  resetSharedRedis,
  sanitizeRedisConnectionError,
} from "./redis.server.js";

const redisEnvNames = [
  "REDIS_URL",
  "UPSTASH_KV_REST_API_URL",
  "UPSTASH_KV_REST_API_TOKEN",
  "REDIS_KV_REST_API_URL",
  "REDIS_KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;
const originalRedisEnv = Object.fromEntries(redisEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  resetSharedRedis();
  vi.unstubAllGlobals();
  for (const name of redisEnvNames) {
    const value = originalRedisEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("sanitizeRedisConnectionError", () => {
  it("preserves actionable error metadata without leaking Redis credentials", () => {
    const source = Object.assign(
      new Error("connect ECONNREFUSED rediss://user:secret@example.test:6379/0"),
      { code: "ECONNREFUSED" },
    );

    const sanitized = sanitizeRedisConnectionError(source) as Error & { code?: unknown };

    expect(sanitized.message).toBe("connect ECONNREFUSED redis://[redacted]");
    expect(sanitized.message).not.toContain("secret");
    expect(sanitized.code).toBe("ECONNREFUSED");
  });

  it("normalizes non-Error failures", () => {
    expect(sanitizeRedisConnectionError("connection failed").message).toBe("connection failed");
  });
});

describe.sequential("REST Redis client", () => {
  it("prefers the current prefixed REST transport over stale legacy credentials", async () => {
    process.env["REDIS_URL"] = "rediss://tcp.example.test:6379";
    process.env["REDIS_KV_REST_API_URL"] = "https://stale.example.test";
    process.env["REDIS_KV_REST_API_TOKEN"] = "stale-token";
    process.env["UPSTASH_KV_REST_API_URL"] = "https://redis.example.test";
    process.env["UPSTASH_KV_REST_API_TOKEN"] = "test-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(isRedisConfigured()).toBe(true);
    const client = await getSharedRedis();
    const result = await client?.eval("return ARGV[1]", 1, "key", 2);

    expect(result).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://redis.example.test");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(String(init.body))).toEqual(["EVAL", "return ARGV[1]", 1, "key", 2]);
  });

  it("returns a safe machine-readable code for REST authentication failures", async () => {
    delete process.env["REDIS_URL"];
    process.env["REDIS_KV_REST_API_URL"] = "https://redis.example.test";
    process.env["REDIS_KV_REST_API_TOKEN"] = "must-not-leak";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const client = await getSharedRedis();
    await expect(client?.ping()).rejects.toMatchObject({
      message: "Redis REST authentication failed",
      code: "UPSTASH_HTTP_401",
    });
    await expect(client?.ping()).rejects.not.toThrow(/must-not-leak/);
  });
});
