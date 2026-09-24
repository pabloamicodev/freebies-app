import { describe, expect, it } from "vitest";
import { isLocalDatabaseUrl, normalizeDatabaseUrl } from "./connection-url.js";

describe("database connection URL hardening", () => {
  it("forces full TLS verification for remote databases", () => {
    const normalized = new URL(normalizeDatabaseUrl("postgresql://user:pass@db.example.com/app?sslmode=require"));
    expect(normalized.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("does not require TLS for localhost development", () => {
    const normalized = new URL(normalizeDatabaseUrl("postgresql://localhost/app?sslmode=require"));
    expect(normalized.searchParams.has("sslmode")).toBe(false);
    expect(isLocalDatabaseUrl(normalized.toString())).toBe(true);
  });

  it("rejects non-Postgres protocols", () => {
    expect(() => normalizeDatabaseUrl("https://db.example.com/app")).toThrow(/postgres/i);
  });
});
