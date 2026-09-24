import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

const {
  ApiError,
  apiError,
  apiJson,
  getRequestId,
  handleApiError,
  readJsonBody,
} = await import("./api-response.server.js");

describe("API response helpers", () => {
  it("preserves a valid incoming request id", () => {
    const request = new Request("https://example.com", {
      headers: { "x-request-id": "req-123:abc" },
    });
    expect(getRequestId(request)).toBe("req-123:abc");
  });

  it("replaces an unsafe request id", () => {
    const request = new Request("https://example.com", {
      headers: { "x-request-id": "bad id value" },
    });
    expect(getRequestId(request)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns backward-compatible structured errors", async () => {
    const request = new Request("https://example.com", {
      headers: { "x-request-id": "req-structured" },
    });
    const response = apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many requests.",
      retryable: true,
      retryAfterSeconds: 12,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("x-request-id")).toBe("req-structured");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Too many requests.",
      code: "RATE_LIMITED",
      requestId: "req-structured",
      retryable: true,
    });
  });

  it("does not expose unexpected internal error messages", async () => {
    const request = new Request("https://example.com");
    const response = handleApiError(request, new Error("password=secret"), "test.route");
    const body = await response.json() as { error: string };
    expect(response.status).toBe(500);
    expect(body.error).not.toContain("secret");
  });

  it("preserves explicit safe ApiError details", async () => {
    const request = new Request("https://example.com");
    const response = handleApiError(request, new ApiError({
      status: 400,
      code: "INVALID_INPUT",
      message: "Invalid input.",
      details: { field: "name" },
    }), "test.route");
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_INPUT",
      details: { field: "name" },
    });
  });

  it("rejects oversized JSON before parsing", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "content-length": "1000" },
      body: "{}",
    });
    await expect(readJsonBody(request, { maxBytes: 10 })).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("adds correlation and hardening headers to success responses", () => {
    const request = new Request("https://example.com", {
      headers: { "x-request-id": "req-success" },
    });
    const response = apiJson(request, { ok: true });
    expect(response.headers.get("x-request-id")).toBe("req-success");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
