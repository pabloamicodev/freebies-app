import { afterEach, describe, expect, it, vi } from "vitest";
import { CSV_PARSE_ERRORS, SIMULATOR_INPUT_ERRORS, WEBHOOK_URL_ERRORS, safeErrorMessage } from "./safe-error.js";

afterEach(() => vi.restoreAllMocks());

describe("safeErrorMessage", () => {
  it("passes allowlisted validation messages", () => {
    expect(safeErrorMessage(new Error("Webhook URL must use HTTPS"), "x", WEBHOOK_URL_ERRORS)).toBe("Webhook URL must use HTTPS");
    expect(safeErrorMessage(new Error("CSV field exceeds 10,000 characters"), "x", CSV_PARSE_ERRORS)).toBe("CSV field exceeds 10,000 characters");
    expect(safeErrorMessage(new Error("Line properties must be a JSON object."), "x", SIMULATOR_INPUT_ERRORS)).toBe("Line properties must be a JSON object.");
  });

  it("replaces anything else with the fallback and logs it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leak = new Error('duplicate key value violates unique constraint "offers_pkey"');
    expect(safeErrorMessage(leak, "Could not save.", WEBHOOK_URL_ERRORS)).toBe("Could not save.");
    expect(safeErrorMessage(new SyntaxError("Unexpected token < in JSON at position 0"), "Could not save.")).toBe("Could not save.");
    expect(safeErrorMessage({ weird: true }, "Could not save.")).toBe("Could not save.");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("anchors string rules to the full message", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(safeErrorMessage(new Error("Webhook URL must use HTTPS; select * from shops"), "f", WEBHOOK_URL_ERRORS)).toBe("f");
  });
});
