import { describe, it, expect } from "vitest";
import { evaluateCountry } from "./country.js";

describe("evaluateCountry", () => {
  it("passes when no restrictions configured", () => {
    const result = evaluateCountry("US", {});
    expect(result.ok).toBe(true);
  });

  it("passes when country in include list", () => {
    const result = evaluateCountry("US", { includeCountryCodes: ["US", "CA"] });
    expect(result.ok).toBe(true);
  });

  it("fails when country NOT in include list", () => {
    const result = evaluateCountry("MX", { includeCountryCodes: ["US", "CA"] });
    expect(result.ok).toBe(false);
  });

  it("fails when country is in exclude list", () => {
    const result = evaluateCountry("CN", { excludeCountryCodes: ["CN", "RU"] });
    expect(result.ok).toBe(false);
  });

  it("passes when country not in exclude list", () => {
    const result = evaluateCountry("US", { excludeCountryCodes: ["CN", "RU"] });
    expect(result.ok).toBe(true);
  });

  it("fails when countryCode is null and include list is set", () => {
    const result = evaluateCountry(null, { includeCountryCodes: ["US"] });
    expect(result.ok).toBe(false);
  });

  it("passes when countryCode is null and exclude list is set (unknown = not excluded)", () => {
    const result = evaluateCountry(null, { excludeCountryCodes: ["CN"] });
    expect(result.ok).toBe(true);
  });

  it("is case-insensitive", () => {
    const result = evaluateCountry("us", { includeCountryCodes: ["US"] });
    expect(result.ok).toBe(true);
  });
});
