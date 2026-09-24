export type HealthCheckStatus = "ok" | "fail" | "degraded" | "not_configured";

export interface DependencyHealth {
  status: HealthCheckStatus;
  critical: boolean;
  latencyMs?: number;
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
