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

  // Regression test: getOfferDefinitions (the storefront-evaluate hot path)
  // and offer-publisher.server.ts both hash the same offer row through this
  // function, but they select different column subsets — offer-definitions
  // omits requiredDiscountCode/codeDiscountId entirely, while the publisher
  // selects every column including those two. If either field weren't in
  // VOLATILE_KEYS, the two hashes would diverge the moment a code offer's
  // codeDiscountId gets set, and cart validation would reject every gift in
  // the shop as "outdated" (it compares this hash against what got stamped
  // on the cart at evaluate time).
  it("is unaffected by requiredDiscountCode/codeDiscountId, so the publisher's full-row hash matches getOfferDefinitions' narrower one", () => {
    const withoutCodeFields = computeOfferVersion(offer, conditions, rewards, null);
    const withCodeFields = computeOfferVersion(
      { ...offer, requiredDiscountCode: "PRIMEDAY2026", codeDiscountId: null },
      conditions,
      rewards,
      null,
    );
    const afterCodeDiscountCreated = computeOfferVersion(
      { ...offer, requiredDiscountCode: "PRIMEDAY2026", codeDiscountId: "gid://shopify/DiscountCodeNode/1" },
      conditions,
      rewards,
      null,
    );

    expect(withCodeFields).toBe(withoutCodeFields);
    expect(afterCodeDiscountCreated).toBe(withoutCodeFields);
  });

  it("is unaffected by codeRedemption: getOfferDefinitions omits it, the publisher hashes the full row", () => {
    const base = computeOfferVersion(offer, conditions, rewards, null);
    expect(computeOfferVersion({ ...offer, codeRedemption: "automatic" }, conditions, rewards, null)).toBe(base);
    expect(computeOfferVersion({ ...offer, codeRedemption: "checkout_code" }, conditions, rewards, null)).toBe(base);
  });
});
