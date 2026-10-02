import { describe, expect, it } from "vitest";
import { fromStoredAmount, toStoredAmount } from "./money.js";

describe("money", () => {
  it("keeps x100 for two-decimal currencies", () => {
    expect(toStoredAmount(10.5, "USD")).toBe(1050);
    expect(toStoredAmount(19.99, "eur")).toBe(1999);
    expect(fromStoredAmount(1050, "USD")).toBe(10.5);
  });
  it("stores whole units for zero-decimal currencies", () => {
    expect(toStoredAmount(500, "JPY")).toBe(500);
    expect(toStoredAmount(500.4, "krw")).toBe(500);
    expect(fromStoredAmount(500, "JPY")).toBe(500);
  });
  it("round-trips", () => {
    for (const c of ["USD", "JPY", "VND"]) expect(fromStoredAmount(toStoredAmount(12, c), c)).toBe(12);
  });
  it("falls back to two decimals for unknown currency", () => {
    expect(toStoredAmount(5, undefined)).toBe(500);
  });
});
