/** Drizzle 0.44+ wraps driver errors in a DrizzleQueryError whose `cause` is the
 * real Postgres error, so the 23505 code (and constraint) live somewhere down
 * the cause chain, not on the thrown error itself. */
function pgErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorChain(error).some((entry) => entry["code"] === "23505");
}

/** Postgres reports the same 23505 code for every unique-violation, regardless
 * of which index fired — callers that retry a unique violation (e.g. by
 * suffixing a name) must check WHICH constraint actually failed, or a retry
 * aimed at one column silently resubmits a different column's real conflict
 * unchanged and fails again, uncaught. The name is `constraint` on node-postgres
 * errors and `constraint_name` on postgres.js (the driver this app uses). */
export function isConstraintViolation(error: unknown, constraintName: string): boolean {
  return pgErrorChain(error).some(
    (entry) =>
      entry["code"] === "23505" &&
      (entry["constraint"] === constraintName || entry["constraint_name"] === constraintName),
  );
}

export function withUniqueOfferSuffix(name: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${name} (${suffix})`;
}
