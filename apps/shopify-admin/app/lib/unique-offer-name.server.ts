export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

export function withUniqueOfferSuffix(name: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${name} (${suffix})`;
}
