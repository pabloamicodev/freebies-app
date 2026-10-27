import { describe, expect, it } from "vitest";
import { variantEligibility } from "./picker-eligibility.js";

const v = (availableForSale: boolean, requiresSellingPlan = false) => ({ availableForSale, requiresSellingPlan });

describe("variantEligibility block", () => {
  it("allows sellable variants", () => {
    expect(variantEligibility(v(true), "block")).toEqual({ selectable: true, reason: null, warning: null });
  });
  it("keeps sold-out variants selectable with the sold_out warning", () => {
    expect(variantEligibility(v(false), "block")).toEqual({ selectable: true, reason: null, warning: "sold_out" });
  });
  it("blocks subscription-only variants", () => {
    expect(variantEligibility(v(true, true), "block")).toEqual({ selectable: false, reason: "subscription_only", warning: null });
  });
  it("blocks a sold-out subscription-only variant", () => {
    expect(variantEligibility(v(false, true), "block")).toEqual({ selectable: false, reason: "subscription_only", warning: null });
  });
});

describe("variantEligibility warn", () => {
  it("allows sellable variants without a warning", () => {
    expect(variantEligibility(v(true), "warn")).toEqual({ selectable: true, reason: null, warning: null });
  });
  it("allows sold-out variants with a warning", () => {
    expect(variantEligibility(v(false), "warn")).toEqual({ selectable: true, reason: null, warning: "sold_out" });
  });
  it("allows subscription-only variants", () => {
    expect(variantEligibility(v(true, true), "warn").selectable).toBe(true);
  });
});
