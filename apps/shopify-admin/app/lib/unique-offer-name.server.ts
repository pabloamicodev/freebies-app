export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

/** Postgres reports the same 23505 code for every unique-violation, regardless
 * of which index fired — callers that retry a unique violation (e.g. by
 * suffixing a name) must check WHICH constraint actually failed, or a retry
 * aimed at one column silently resubmits a different column's real conflict
 * unchanged and fails again, uncaught. */
export function isConstraintViolation(error: unknown, constraintName: string): boolean {
  return (
    isUniqueViolation(error) &&
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint === constraintName
  );
}

export function withUniqueOfferSuffix(name: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${name} (${suffix})`;
}
