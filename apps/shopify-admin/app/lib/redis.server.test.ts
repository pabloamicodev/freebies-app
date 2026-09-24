import { describe, expect, it } from "vitest";
import { sanitizeRedisConnectionError } from "./redis.server.js";

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
