/**
 * Unit tests for offer-validation.server.ts — pure functions, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  parseDateRange,
  requiredText,
  parseInteger,
  parseMoneyAmount,
  parseJsonStringArray,
  ensureOneOf,
} from "./offer-validation.server.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

// ─── parseDateRange ───────────────────────────────────────────────────────────

describe("parseDateRange", () => {
  it("returns null dates when both fields are empty", () => {
    const result = parseDateRange(fd({}));
    expect(result.error).toBeNull();
    expect(result.data?.startsAt).toBeNull();
    expect(result.data?.endsAt).toBeNull();
  });

  it("accepts valid start-only (no end = runs indefinitely)", () => {
    const result = parseDateRange(fd({ startsAt: "2027-01-01T10:00" }));
    expect(result.error).toBeNull();
    expect(result.data?.startsAt).toBeInstanceOf(Date);
    expect(result.data?.endsAt).toBeNull();
  });

  it("accepts valid start and end range", () => {
    const result = parseDateRange(fd({ startsAt: "2027-01-01T10:00", endsAt: "2027-06-01T10:00" }));
    expect(result.error).toBeNull();
    expect(result.data?.startsAt).toBeInstanceOf(Date);
    expect(result.data?.endsAt).toBeInstanceOf(Date);
    expect(result.data!.endsAt! > result.data!.startsAt!).toBe(true);
  });

  it("rejects end before start", () => {
    const result = parseDateRange(fd({ startsAt: "2027-06-01T10:00", endsAt: "2027-01-01T10:00" }));
    expect(result.error).toMatch(/end date must be after/i);
  });

  it("rejects equal start and end", () => {
    const result = parseDateRange(fd({ startsAt: "2027-01-01T10:00", endsAt: "2027-01-01T10:00" }));
    expect(result.error).toMatch(/end date must be after/i);
  });

  it("rejects end without start", () => {
    const result = parseDateRange(fd({ endsAt: "2027-06-01T10:00" }));
    expect(result.error).toMatch(/start date/i);
  });

  it("rejects invalid start date string", () => {
    const result = parseDateRange(fd({ startsAt: "not-a-date" }));
    expect(result.error).toMatch(/start date is invalid/i);
  });

  it("rejects invalid end date string", () => {
    const result = parseDateRange(fd({ startsAt: "2027-01-01T10:00", endsAt: "banana" }));
    expect(result.error).toMatch(/end date is invalid/i);
  });

  it("respects timezone offset (America/New_York vs UTC)", () => {
    // 2027-01-01T10:00 in NY (UTC-5 in Jan) should be 15:00 UTC
    const utcResult = parseDateRange(fd({ startsAt: "2027-01-01T10:00" }), "UTC");
    const nyResult = parseDateRange(fd({ startsAt: "2027-01-01T10:00" }), "America/New_York");
    expect(utcResult.data?.startsAt?.getTime()).not.toBe(nyResult.data?.startsAt?.getTime());
    // NY result should be 5h later than UTC result
    const diff = utcResult.data!.startsAt!.getTime() - nyResult.data!.startsAt!.getTime();
    expect(Math.abs(diff)).toBe(5 * 60 * 60 * 1000);
  });

  it("handles a DST boundary date correctly (no NaN)", () => {
    // 2027-03-14 is US DST switch — 2:00AM skipped
    const result = parseDateRange(fd({ startsAt: "2027-03-14T02:30" }), "America/New_York");
    // Should not error and should produce a valid Date (Intl handles DST)
    expect(result.error).toBeNull();
    expect(Number.isNaN(result.data?.startsAt?.getTime())).toBe(false);
  });
});

// ─── requiredText ─────────────────────────────────────────────────────────────

describe("requiredText", () => {
  it("returns value when present", () => {
    const result = requiredText(fd({ name: "My Offer" }), "name", "Name");
    expect(result.data).toBe("My Offer");
    expect(result.error).toBeNull();
  });

  it("trims whitespace before checking", () => {
    const result = requiredText(fd({ name: "  hello  " }), "name", "Name");
    expect(result.data).toBe("hello");
  });

  it("fails on empty string", () => {
    const result = requiredText(fd({ name: "" }), "name", "Name");
    expect(result.error).toMatch(/required/i);
  });

  it("fails on whitespace-only string", () => {
    const result = requiredText(fd({ name: "   " }), "name", "Name");
    expect(result.error).toMatch(/required/i);
  });

  it("fails when field is missing from FormData", () => {
    const result = requiredText(fd({}), "name", "Name");
    expect(result.error).toMatch(/required/i);
  });
});

// ─── parseInteger ─────────────────────────────────────────────────────────────

describe("parseInteger", () => {
  it("parses valid integer", () => {
    expect(parseInteger(fd({ qty: "5" }), "qty", 1).data).toBe(5);
  });

  it("uses fallback when field is empty", () => {
    expect(parseInteger(fd({ qty: "" }), "qty", 42).data).toBe(42);
  });

  it("uses fallback when field missing", () => {
    expect(parseInteger(fd({}), "qty", 42).data).toBe(42);
  });

  it("rejects non-integer string", () => {
    expect(parseInteger(fd({ qty: "abc" }), "qty", 1).error).toBeTruthy();
  });

  it("rejects float", () => {
    expect(parseInteger(fd({ qty: "3.5" }), "qty", 1).error).toBeTruthy();
  });

  it("rejects below min", () => {
    expect(parseInteger(fd({ qty: "0" }), "qty", 1, { min: 1 }).error).toMatch(/at least 1/);
  });

  it("rejects above max", () => {
    expect(parseInteger(fd({ qty: "101" }), "qty", 1, { max: 100 }).error).toMatch(/at most 100/);
  });

  it("accepts boundary values", () => {
    expect(parseInteger(fd({ qty: "1" }), "qty", 0, { min: 1, max: 100 }).data).toBe(1);
    expect(parseInteger(fd({ qty: "100" }), "qty", 0, { min: 1, max: 100 }).data).toBe(100);
  });
});

// ─── parseMoneyAmount ─────────────────────────────────────────────────────────

describe("parseMoneyAmount", () => {
  it("parses decimal amount", () => {
    expect(parseMoneyAmount(fd({ price: "19.99" }), "price", 0).data).toBeCloseTo(19.99);
  });

  it("rejects NaN", () => {
    expect(parseMoneyAmount(fd({ price: "abc" }), "price", 0).error).toBeTruthy();
  });

  it("rejects Infinity", () => {
    expect(parseMoneyAmount(fd({ price: "Infinity" }), "price", 0).error).toBeTruthy();
  });

  it("uses fallback when empty", () => {
    expect(parseMoneyAmount(fd({ price: "" }), "price", 5.0).data).toBe(5.0);
  });

  it("rejects negative when min is 0", () => {
    expect(parseMoneyAmount(fd({ price: "-1" }), "price", 0, { min: 0 }).error).toBeTruthy();
  });
});

// ─── parseJsonStringArray ─────────────────────────────────────────────────────

describe("parseJsonStringArray", () => {
  it("parses valid array", () => {
    const result = parseJsonStringArray(fd({ ids: '["a","b","c"]' }), "ids");
    expect(result.data).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when field missing", () => {
    expect(parseJsonStringArray(fd({}), "ids").data).toEqual([]);
  });

  it("rejects non-string array elements", () => {
    expect(parseJsonStringArray(fd({ ids: "[1, 2]" }), "ids").error).toBeTruthy();
  });

  it("rejects non-array JSON", () => {
    expect(parseJsonStringArray(fd({ ids: '{"a":1}' }), "ids").error).toBeTruthy();
  });

  it("rejects invalid JSON", () => {
    expect(parseJsonStringArray(fd({ ids: "not-json" }), "ids").error).toBeTruthy();
  });
});

// ─── ensureOneOf ──────────────────────────────────────────────────────────────

describe("ensureOneOf", () => {
  const types = ["gift", "upsell", "bundle"] as const;

  it("accepts valid value", () => {
    expect(ensureOneOf("gift", types, "gift", "type").data).toBe("gift");
  });

  it("returns fallback when null", () => {
    expect(ensureOneOf(null, types, "gift", "type").data).toBe("gift");
  });

  it("rejects invalid value", () => {
    expect(ensureOneOf("hack", types, "gift", "type").error).toBeTruthy();
  });
});
