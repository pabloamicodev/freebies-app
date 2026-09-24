/**
 * Unit tests for rate-limit.server.ts
 * Mocks the shared backends to test the distributed DB fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB before importing the module ──────────────────────────────────────

const mockExecute = vi.fn();
vi.mock("@promo/db", () => ({
  getDb: () => ({ execute: mockExecute }),
}));

vi.mock("./redis.server.js", () => ({
  getSharedRedis: () => Promise.resolve(null),
  resetSharedRedis: () => undefined,
}));

// Import AFTER the mock is registered
const { checkRateLimit, getClientIp } = await import("./rate-limit.server.js");

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDbRow(count: number, retryAfter = 0) {
  mockExecute.mockResolvedValueOnce([{ count, retry_after: retryAfter }]);
}

// ─── getClientIp ──────────────────────────────────────────────────────────────

describe("getClientIp", () => {
  it("extracts first IP from x-forwarded-for", () => {
    const req = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const req = new Request("https://example.com", {
      headers: { "x-real-ip": "9.9.9.9" },
    });
    expect(getClientIp(req)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no headers present", () => {
    const req = new Request("https://example.com");
    expect(getClientIp(req)).toBe("unknown");
  });
});

// ─── checkRateLimit — DB enforcement ─────────────────────────────────────────

describe("checkRateLimit — DB enforcement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses shared enforcement from the first request", async () => {
    makeDbRow(1);

    const result = await checkRateLimit(`test-first-${Date.now()}`, {
      limit: 100,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("allows request when DB count is within limit", async () => {
    makeDbRow(3);

    const result = await checkRateLimit(`test-allow-${Date.now()}`, {
      limit: 3,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("blocks request when DB count exceeds limit", async () => {
    makeDbRow(3, 30);

    const result = await checkRateLimit(`test-block-${Date.now()}`, {
      limit: 2,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("returns retryAfterSeconds >= 1 when blocked", async () => {
    makeDbRow(2, 45);

    const result = await checkRateLimit(`test-retry-${Date.now()}`, {
      limit: 1,
      windowMs: 60_000,
    });

    expect(result).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
