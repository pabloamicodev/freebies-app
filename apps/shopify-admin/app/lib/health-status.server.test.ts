import { describe, expect, it } from "vitest";
import { summarizeHealthChecks } from "./health-status.server.js";

describe("summarizeHealthChecks", () => {
  it("is healthy when critical checks pass and optional services are absent", () => {
    expect(summarizeHealthChecks({
      database: { status: "ok", critical: true },
      redis: { status: "not_configured", critical: false },
    })).toEqual({ status: "ok", statusCode: 200 });
  });

  it("reports optional service failures without taking the app out of readiness", () => {
    expect(summarizeHealthChecks({
      database: { status: "ok", critical: true },
      redis: { status: "degraded", critical: false },
    })).toEqual({ status: "degraded", statusCode: 200 });
  });

  it("returns 503 when a critical dependency fails", () => {
    expect(summarizeHealthChecks({
      database: { status: "fail", critical: true },
      redis: { status: "ok", critical: false },
    })).toEqual({ status: "unhealthy", statusCode: 503 });
  });
});
