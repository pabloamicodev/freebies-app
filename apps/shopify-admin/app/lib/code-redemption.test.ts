import { describe, expect, it } from "vitest";
import { PAGE_TYPES } from "@promo/shared-types";
import {
  AUTOMATIC_NO_ORDER_COMBINE_WARNING,
  AUTOMATIC_SITEWIDE_WARNING,
  automaticModeWarnings,
  isCheckoutCodeGated,
} from "./code-redemption.js";

const plain = { requiresCode: false, requiredDiscountCode: null };

describe("isCheckoutCodeGated", () => {
  it("gates on the flag, a legacy code or any code row in checkout mode", () => {
    expect(isCheckoutCodeGated(plain, false)).toBe(false);
    expect(isCheckoutCodeGated({ ...plain, requiresCode: true }, false)).toBe(true);
    expect(isCheckoutCodeGated({ ...plain, requiredDiscountCode: "SAVE" }, false)).toBe(true);
    expect(isCheckoutCodeGated(plain, true)).toBe(true);
    expect(isCheckoutCodeGated({ ...plain, codeRedemption: "checkout_code", requiresCode: true }, false)).toBe(true);
  });

  it("never gates an automatic offer, whatever codes it keeps", () => {
    const automatic = { codeRedemption: "automatic" as const, requiresCode: true, requiredDiscountCode: "SAVE" };
    expect(isCheckoutCodeGated(automatic, true)).toBe(false);
  });
});

describe("automaticModeWarnings", () => {
  it("warns about order-discount combination and about all-pages", () => {
    expect(automaticModeWarnings({ combinesWithOrderDiscounts: true, pageTypes: ["home"] })).toEqual([]);
    expect(automaticModeWarnings({ combinesWithOrderDiscounts: false, pageTypes: PAGE_TYPES })).toEqual([
      AUTOMATIC_NO_ORDER_COMBINE_WARNING,
      AUTOMATIC_SITEWIDE_WARNING,
    ]);
  });
});
