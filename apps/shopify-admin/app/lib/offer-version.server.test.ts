import { describe, expect, it } from "vitest";
import { computeOfferVersion } from "./offer-version.server.js";

describe("computeOfferVersion", () => {
  const offer = {
    id: "offer-1",
    type: "gift",
    status: "active",
    priority: 10,
    compiledConfig: { stale: true },
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const conditions = [
    { id: "condition-2", conditionType: "cart_quantity", value: { minQuantity: 2 } },
    { id: "condition-1", conditionType: "cart_value", value: { thresholdCents: 5000 } },
  ];
  const rewards = [
    { id: "reward-1", rewardType: "product_gift", target: { variantIds: ["variant-1"] }, quantity: 1 },
  ];

  it("is stable across row order and publication metadata changes", () => {
    const first = computeOfferVersion(offer, conditions, rewards, null);
    const second = computeOfferVersion(
      { ...offer, compiledConfig: { newer: true }, updatedAt: new Date("2026-02-02T00:00:00Z") },
      [...conditions].reverse(),
      rewards,
      null,
    );

    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it("changes when an authorization-relevant rule changes", () => {
    const first = computeOfferVersion(offer, conditions, rewards, null);
    const second = computeOfferVersion(
      offer,
      conditions,
      [{ ...rewards[0], quantity: 2 }],
      null,
    );

    expect(second).not.toBe(first);
  });
});
