import { describe, expect, it } from "vitest";
import { healthErrorDetails, summarizeHealthChecks } from "./health-status.server.js";

describe("summarizeHealthChecks", () => {
  it("is healthy when critical checks pass and optional services are absent", () => {
    expect(
      summarizeHealthChecks({
        database: { status: "ok", critical: true },
        redis: { status: "not_configured", critical: false },
      }),
    ).toEqual({ status: "ok", statusCode: 200 });
  });

  it("reports optional service failures without taking the app out of readiness", () => {
    expect(
      summarizeHealthChecks({
        database: { status: "ok", critical: true },
        redis: { status: "degraded", critical: false },
      }),
    ).toEqual({ status: "degraded", statusCode: 200 });
  });

  it("returns 503 when a critical dependency fails", () => {
    expect(
      summarizeHealthChecks({
        database: { status: "fail", critical: true },
        redis: { status: "ok", critical: false },
      }),
    ).toEqual({ status: "unhealthy", statusCode: 503 });
  });

  it("exposes only allowlisted machine-readable error codes", () => {
    expect(healthErrorDetails({ code: "ECONNREFUSED" })).toEqual({
      errorCode: "ECONNREFUSED",
      failureClass: "connection_refused",
    });
    expect(healthErrorDetails({ code: "secret=https://user:password@example.test" })).toEqual({
      failureClass: "unknown",
    });
    expect(healthErrorDetails(new Error("credential-bearing message"))).toEqual({
      failureClass: "unknown",
    });
  });

  it("classifies common dependency failures without exposing their messages", () => {
    expect(healthErrorDetails(new Error("getaddrinfo ENOTFOUND private.redis.example"))).toEqual({
      failureClass: "dns_failed",
    });
    expect(healthErrorDetails(new Error("WRONGPASS invalid username-password pair"))).toEqual({
      failureClass: "authentication_failed",
    });
    expect(healthErrorDetails(new Error("Connection is closed."))).toEqual({
      failureClass: "connection_closed",
    });
  });

  it("classifies the safe root cause wrapped by Node fetch", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND redis.example.test"), {
      code: "ENOTFOUND",
    });
    const error = new TypeError("fetch failed", { cause });

    expect(healthErrorDetails(error)).toEqual({
      errorCode: "ENOTFOUND",
      failureClass: "dns_failed",
    });
  });
});
