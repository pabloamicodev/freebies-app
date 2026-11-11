import { describe, expect, it } from "vitest";
import { baseThresholdLabel, marketThresholdStep, marketThresholdToInput, marketThresholdToStored } from "./market-threshold.js";
import { overrideUnit } from "./money.js";

describe("market widget threshold overrides", () => {
  it("a JPY shop stores a JPY market's threshold in whole yen and shows it back unchanged", () => {
    expect(marketThresholdToStored("5000", "JPY", "JPY")).toBe(5000);
    expect(marketThresholdToInput(5000, "JPY", "JPY")).toBe("5000");
    expect(marketThresholdStep("JPY", "JPY")).toBe(1);
  });

  it("a JPY shop still stores a two-decimal market's threshold x100", () => {
    expect(marketThresholdToStored("12.5", "JPY", "EUR")).toBe(1250);
    expect(marketThresholdToInput(1250, "JPY", "EUR")).toBe("12.5");
    expect(marketThresholdStep("JPY", "EUR")).toBeUndefined();
  });

  it("a USD shop keeps x100 for every market, JPY included (unchanged)", () => {
    expect(marketThresholdToStored("50", "USD", "USD")).toBe(5000);
    expect(marketThresholdToStored("5000", "USD", "JPY")).toBe(500_000);
    expect(marketThresholdToInput(500_000, "USD", "JPY")).toBe("5000");
    expect(marketThresholdStep("USD", "JPY")).toBeUndefined();
  });

  it("an empty field means no override", () => {
    expect(marketThresholdToStored("", "JPY", "JPY")).toBeNull();
    expect(marketThresholdToInput(null, "JPY", "JPY")).toBe("");
  });

  it("prints the base threshold in the shop's unit; two-decimal shops read as before", () => {
    expect(baseThresholdLabel(5000, "USD", "USD")).toBe("$50.00 USD");
    expect(baseThresholdLabel(5000, "JPY", "JPY")).toBe("5000 JPY");
  });

  it("overrideUnit follows the shop, not the market", () => {
    expect(overrideUnit("JPY", "KRW")).toBe("KRW");
    expect(overrideUnit("JPY", "USD")).toBe("USD");
    expect(overrideUnit("USD", "JPY")).toBe("USD");
    expect(overrideUnit(null, "JPY")).toBe("USD");
  });
});
