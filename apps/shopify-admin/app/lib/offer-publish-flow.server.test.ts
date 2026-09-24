import { describe, expect, it } from "vitest";
import { canUseRuntimeOnlyConditions } from "./offer-publish-flow.server.js";

describe("canUseRuntimeOnlyConditions", () => {
  it("allows URL, Market, customer, and one-use conditions to gate gift-only offers", () => {
    expect(canUseRuntimeOnlyConditions(["product_gift"])).toBe(true);
    expect(canUseRuntimeOnlyConditions(["product_gift", "product_gift"])).toBe(true);
  });

  it("keeps automatic checkout discounts behind Function-enforced conditions", () => {
    expect(canUseRuntimeOnlyConditions(["product_discount"])).toBe(false);
    expect(canUseRuntimeOnlyConditions(["product_gift", "shipping_discount"])).toBe(false);
    expect(canUseRuntimeOnlyConditions([])).toBe(false);
  });
});
