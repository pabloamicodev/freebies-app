import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRedisActiveInstance,
  getSharedRedis,
  isRedisConfigured,
  recordRedisFailure,
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
  "BACKUP_KV_REST_API_URL",
  "BACKUP_KV_REST_API_TOKEN",
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

describe.sequential("circuit breaker", () => {
  it("skips Redis entirely for a cool-off window after a recorded failure", async () => {
    process.env["UPSTASH_KV_REST_API_URL"] = "https://redis.example.test";
    process.env["UPSTASH_KV_REST_API_TOKEN"] = "test-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    recordRedisFailure();
    const client = await getSharedRedis();

    expect(client).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes trying Redis once the cool-off window elapses", async () => {
    vi.useFakeTimers();
    try {
      process.env["UPSTASH_KV_REST_API_URL"] = "https://redis.example.test";
      process.env["UPSTASH_KV_REST_API_TOKEN"] = "test-token";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ));

      recordRedisFailure();
      vi.advanceTimersByTime(30_001);

      const client = await getSharedRedis();
      expect(client).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.sequential("REST Redis failover", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const quota = () => json({ error: "ERR max daily request limit exceeded" });
  const clock = new Date("2030-01-01T00:00:00Z").getTime();
  let tick = 0;
  const setup = (withBackup = true) => {
    // primaryExhaustedUntil survives resetSharedRedis, so each test starts well past the previous window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock + tick++ * 3_600_000);
    delete process.env["REDIS_URL"];
    process.env["KV_REST_API_URL"] = "https://primary.example.test";
    process.env["KV_REST_API_TOKEN"] = "p-token";
    if (withBackup) {
      process.env["BACKUP_KV_REST_API_URL"] = "https://backup.example.test";
      process.env["BACKUP_KV_REST_API_TOKEN"] = "b-token";
    }
  };
  const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((c) => c[0]);

  afterEach(() => vi.useRealTimers());

  it("retries on backup after a primary quota error and keeps using backup until the window expires", async () => {
    setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(quota())
      .mockResolvedValueOnce(json({ result: 1 }))
      .mockResolvedValueOnce(json({ result: 2 }))
      .mockResolvedValueOnce(json({ result: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await getSharedRedis();

    expect(await client?.eval("x", 0)).toBe(1);
    expect(getRedisActiveInstance()).toBe("backup");
    expect(await client?.eval("x", 0)).toBe(2);
    expect(urls(fetchMock)).toEqual([
      "https://primary.example.test",
      "https://backup.example.test",
      "https://backup.example.test",
    ]);

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(getRedisActiveInstance()).toBe("primary");
    expect(await client?.eval("x", 0)).toBe(3);
    expect(urls(fetchMock)[3]).toBe("https://primary.example.test");
  });

  it("treats HTTP 429 as quota exhaustion", async () => {
    setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(json({ result: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await (await getSharedRedis())?.eval("x", 0)).toBe("ok");
  });

  it("throws as before when no backup is configured", async () => {
    setup(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quota()));

    await expect((await getSharedRedis())?.eval("x", 0)).rejects.toThrow("Redis REST quota exhausted");
    expect(getRedisActiveInstance()).toBe("primary");
  });

  it("does not switch on non-quota errors", async () => {
    setup();
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "ERR syntax" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect((await getSharedRedis())?.eval("x", 0)).rejects.toThrow("Redis REST command failed");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getRedisActiveInstance()).toBe("primary");
  });

  it("throws when the backup is also exhausted", async () => {
    setup();
    const fetchMock = vi.fn().mockImplementation(async () => quota());
    vi.stubGlobal("fetch", fetchMock);

    await expect((await getSharedRedis())?.eval("x", 0)).rejects.toThrow("Redis REST quota exhausted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
