import { describe, expect, it } from "vitest";
import { escapeCSV, MAX_CSV_FIELD_LENGTH, parseCSV, rowToCSV } from "./csv.js";

describe("CSV utilities", () => {
  it("parses quoted commas, escaped quotes, and embedded newlines", () => {
    expect(parseCSV('name,copy\r\nOffer,"hello, ""world""\nagain"', true)).toEqual([
      ["name", "copy"],
      ["Offer", 'hello, "world"\nagain'],
    ]);
  });

  it("rejects malformed or abusive strict input", () => {
    expect(() => parseCSV('name,"unterminated', true)).toThrow("unterminated");
    expect(() => parseCSV(`name\n${"x".repeat(MAX_CSV_FIELD_LENGTH + 1)}`, true)).toThrow("exceeds");
  });

  it.each(["=2+3", "+cmd", "-1+2", "@SUM(A1:A2)", "\tformula"])(
    "neutralizes spreadsheet formula %s",
    (value) => expect(escapeCSV(value)).toBe(`'${value}`),
  );

  it("escapes ordinary CSV delimiters", () => {
    expect(rowToCSV(["safe", 'hello, "world"'])).toBe('safe,"hello, ""world"""');
  });
});
