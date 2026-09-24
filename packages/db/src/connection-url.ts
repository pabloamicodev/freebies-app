export function normalizeDatabaseUrl(rawUrl: string): string {
  if (!rawUrl) return "";

  const url = new URL(rawUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (isLocal) {
    url.searchParams.delete("sslmode");
  } else {
    // Be explicit before the next pg major changes the historical aliases for
    // prefer/require/verify-ca. Production must always verify hostname + CA.
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

export function isLocalDatabaseUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}
