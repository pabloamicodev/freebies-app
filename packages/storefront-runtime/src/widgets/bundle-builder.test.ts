import { describe, expect, it } from "vitest";
import { getActiveTier } from "./bundle-builder.js";

describe("getActiveTier", () => {
  const tiers = [
    {
      minQuantity: 2,
      maxQuantity: 3,
      label: "Starter",
      discountType: "percentage",
      discountValue: 10,
    },
    {
      minQuantity: 4,
      maxQuantity: 5,
      label: "Growth",
      discountType: "percentage",
      discountValue: 20,
    },
    { minQuantity: 7, label: "Max", discountType: "percentage", discountValue: 30 },
  ];

  it("honors lower and upper inclusive tier boundaries", () => {
    expect(getActiveTier(1, tiers)).toBeNull();
    expect(getActiveTier(2, tiers)?.label).toBe("Starter");
    expect(getActiveTier(3, tiers)?.label).toBe("Starter");
    expect(getActiveTier(4, tiers)?.label).toBe("Growth");
    expect(getActiveTier(6, tiers)).toBeNull();
    expect(getActiveTier(7, tiers)?.label).toBe("Max");
  });
});
