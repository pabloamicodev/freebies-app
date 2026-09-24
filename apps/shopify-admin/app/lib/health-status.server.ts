export type HealthCheckStatus = "ok" | "fail" | "degraded" | "not_configured";

export interface DependencyHealth {
  status: HealthCheckStatus;
  critical: boolean;
  latencyMs?: number;
  /** Stable machine-readable reason; never include exception messages or secrets. */
  reason?: "query_failed" | "connection_failed" | "missing_required_environment";
  /** Allowlisted runtime/network error code such as ECONNREFUSED or ETIMEDOUT. */
  errorCode?: string;
  /** Coarse safe category derived from the error without exposing its message. */
  failureClass?: HealthFailureClass;
}

export type HealthFailureClass =
  | "invalid_url"
  | "dns_failed"
  | "connection_refused"
  | "connection_timeout"
  | "tls_failed"
  | "authentication_failed"
  | "connection_closed"
  | "unknown";

export function healthErrorDetails(
  error: unknown,
): Pick<DependencyHealth, "errorCode" | "failureClass"> {
  const code = (error as { code?: unknown } | null)?.code;
  const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = `${errorCode ?? ""} ${message}`.toLowerCase();

  let failureClass: HealthFailureClass = "unknown";
  if (/invalid.*url|url.*invalid/.test(normalized)) failureClass = "invalid_url";
  else if (/enotfound|eai_again|getaddrinfo|dns/.test(normalized)) failureClass = "dns_failed";
  else if (/econnrefused|connection refused/.test(normalized)) failureClass = "connection_refused";
  else if (/etimedout|timeout|timed out/.test(normalized)) failureClass = "connection_timeout";
  else if (/certificate|tls|ssl/.test(normalized)) failureClass = "tls_failed";
  else if (/wrongpass|noauth|authentication|unauthorized/.test(normalized)) failureClass = "authentication_failed";
  else if (/connection.*closed|socket.*closed/.test(normalized)) failureClass = "connection_closed";

  return {
    ...(errorCode ? { errorCode } : {}),
    failureClass,
  };
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
