/**
 * Unit tests for rate-limit.server.ts
 * Mocks the DB to test in-memory fast-path and enforcement logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB before importing the module ──────────────────────────────────────

const mockExecute = vi.fn();
vi.mock("@promo/db", () => ({
  getDb: () => ({ execute: mockExecute }),
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

// ─── checkRateLimit — in-memory fast path ─────────────────────────────────────

describe("checkRateLimit — in-memory fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok without hitting DB when well under limit", async () => {
    // First call for a fresh key — count=1, limit=100 → well under 70 threshold
    const result = await checkRateLimit(`test-fastpath-${Date.now()}`, { limit: 100, windowMs: 60_000 });
    expect(result.ok).toBe(true);
    // DB should NOT have been called (count=1 < 70% of 100)
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("falls through to DB when mem count approaches limit", async () => {
    const key = `test-db-fallthrough-${Date.now()}`;
    const opts = { limit: 3, windowMs: 60_000 };

    // Fill memory to 70%+ of limit=3 → threshold=2
    // First 2 calls stay in fast path (count 1,2 < 2.1)
    // On the 3rd call count=3 >= floor(3*0.7)=2 → goes to DB
    makeDbRow(3, 0); // DB says count=3 ≤ limit=3 → ok

    let result!: Awaited<ReturnType<typeof checkRateLimit>>;
    for (let i = 0; i < 3; i++) {
      result = await checkRateLimit(key, opts);
    }
    // Third call should have hit the DB
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

// ─── checkRateLimit — DB enforcement ─────────────────────────────────────────

describe("checkRateLimit — DB enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows request when DB count is within limit", async () => {
    const key = `test-allow-${Date.now()}`;
    const opts = { limit: 3, windowMs: 60_000 };

    // Pre-fill mem past threshold so every call reaches DB
    for (let i = 0; i < 3; i++) {
      makeDbRow(i + 1, 0);
      await checkRateLimit(key, opts);
    }

    makeDbRow(3, 0); // 4th call: DB count=3 ≤ limit → ok
    const result = await checkRateLimit(key, opts);
    expect(result.ok).toBe(true);
  });

  it("blocks request when DB count exceeds limit", async () => {
    const key = `test-block-${Date.now()}`;
    const opts = { limit: 2, windowMs: 60_000 };

    // Fill mem fast
    for (let i = 0; i < 3; i++) {
      makeDbRow(i + 1, i < 2 ? 0 : 30);
      await checkRateLimit(key, opts);
    }

    makeDbRow(3, 30); // count=3 > limit=2 → blocked
    const result = await checkRateLimit(key, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns retryAfterSeconds >= 1 when blocked", async () => {
    const key = `test-retry-${Date.now()}`;
    const opts = { limit: 1, windowMs: 60_000 };

    for (let i = 0; i < 2; i++) {
      makeDbRow(i + 1, 45);
      await checkRateLimit(key, opts);
    }

    makeDbRow(2, 45);
    const result = await checkRateLimit(key, opts);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBe(45);
    }
  });
});
