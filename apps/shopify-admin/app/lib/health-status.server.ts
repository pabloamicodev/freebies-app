export type HealthCheckStatus = "ok" | "fail" | "degraded" | "not_configured";

export interface DependencyHealth {
  status: HealthCheckStatus;
  critical: boolean;
  latencyMs?: number;
  /** Stable machine-readable reason; never include exception messages or secrets. */
  reason?: "query_failed" | "connection_failed" | "missing_required_environment";
  /** Allowlisted runtime/network error code such as ECONNREFUSED or ETIMEDOUT. */
  errorCode?: string;
}

export function healthErrorDetails(error: unknown): Pick<DependencyHealth, "errorCode"> {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? { errorCode: code }
    : {};
}

export function summarizeHealthChecks(checks: Record<string, DependencyHealth>) {
  const criticalChecksOk = Object.values(checks).every(
    ({ status, critical }) => !critical || status === "ok",
  );
  const degraded = Object.values(checks).some(({ status }) => status === "degraded");

  return {
    status: !criticalChecksOk ? "unhealthy" as const : degraded ? "degraded" as const : "ok" as const,
    statusCode: criticalChecksOk ? 200 as const : 503 as const,
  };
}
