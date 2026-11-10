import { describe, expect, it } from "vitest";
import type { CompiledOffer } from "./compile-config.js";
import { buildPlanUnits, cartAttributeKeysOf } from "./plan-units.js";
import { unitBytes } from "./shard-planner.js";

function offer(overrides: Partial<CompiledOffer> = {}): CompiledOffer {
  return {
    id: "o",
    version: 1,
    offerType: "discount",
    priority: 5,
    stopLowerPriority: false,
    requiredProductIds: [],
    requiredVariantIds: [],
    anyRequiredProductIds: [],
    anyRequiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "percentage",
    discountValue: 10,
    currencyCode: "USD",
    combinesWithOrderDiscounts: true,
    combinesWithShippingDiscounts: true,
    combinesWithProductDiscounts: true,
    requirements: [],
    giftRewards: [],
    productRewards: [],
    orderRewards: [],
    ...overrides,
  };
}

const productReward = (overrides: Record<string, unknown> = {}) =>
  ({ id: "r", targetProductIds: ["p1"], targetVariantIds: [], scopeMode: "sitewide", ...overrides }) as never;

const condition = (offerId: string, conditionType: string, value: unknown, isEnabled = true) =>
  ({ offerId, conditionType, value, isEnabled }) as never;

describe("buildPlanUnits", () => {
  it("keys the unit by offer id and measures it with the planner's own unitBytes", () => {
    const compiled = offer({ id: "a" });
    const [unit] = buildPlanUnits([{ offerId: "a", offer: compiled }], [], []);
    expect(unit!.key).toBe("a");
    expect(unit!.bytes).toBe(unitBytes(compiled));
  });

  it("measures with compact ids when the shop flag is on", () => {
    const compiled = offer({ id: "a", requiredVariantIds: ["gid://shopify/ProductVariant/123456789"] });
    const [on] = buildPlanUnits([{ offerId: "a", offer: compiled }], [], [], true);
    expect(on!.bytes).toBe(unitBytes(compiled, true));
    expect(on!.bytes).toBeLessThan(unitBytes(compiled));
  });

  it("takes sorted cart attribute keys only from enabled cart_attribute conditions of that offer", () => {
    const conditions = [
      condition("a", "cart_attribute", { key: " zeta " }),
      condition("a", "cart_attribute", { key: "alpha" }),
      condition("a", "cart_attribute", { key: "alpha" }),
      condition("a", "cart_attribute", { key: "off" }, false),
      condition("a", "line_attribute", { key: "line" }),
      condition("a", "cart_attribute", { key: "  " }),
      condition("b", "cart_attribute", { key: "other" }),
    ];
    const [a, b] = buildPlanUnits(
      [
        { offerId: "a", offer: offer({ id: "a" }) },
        { offerId: "b", offer: offer({ id: "b" }) },
      ],
      conditions,
      [],
    );
    expect(a!.cartAttributeKeys).toEqual(["alpha", "zeta"]);
    expect(b!.cartAttributeKeys).toEqual(["other"]);
    expect(cartAttributeKeysOf([])).toEqual([]);
  });

  it("merges required and excluded customer tags, deduplicated and sorted", () => {
    const [unit] = buildPlanUnits(
      [{ offerId: "a", offer: offer({ requiredCustomerTags: ["vip", "b2b"], excludedCustomerTags: ["vip", "banned"] }) }],
      [],
      [],
    );
    expect(unit!.customerTags).toEqual(["b2b", "banned", "vip"]);
  });

  it("copies priority and flags order rewards", () => {
    const orderReward = { id: "x", discountType: "percentage", discountValue: 5, subtotalTiers: [] } as never;
    const [plain, order] = buildPlanUnits(
      [
        { offerId: "a", offer: offer({ priority: 3 }) },
        { offerId: "b", offer: offer({ priority: 9, orderRewards: [orderReward] }) },
      ],
      [],
      [],
    );
    expect([plain!.priority, plain!.hasOrderRewards]).toEqual([3, false]);
    expect([order!.priority, order!.hasOrderRewards]).toEqual([9, true]);
  });

  it("reads stopLowerPriority from the combination policy, falling back to the compiled offer", () => {
    const [withPolicy, withoutPolicy, policyOff] = buildPlanUnits(
      [
        { offerId: "a", offer: offer() },
        { offerId: "b", offer: offer({ stopLowerPriority: true }) },
        { offerId: "c", offer: offer({ stopLowerPriority: true }) },
      ],
      [],
      [
        { offerId: "a", stopLowerPriority: true },
        { offerId: "c", stopLowerPriority: false },
      ],
    );
    expect(withPolicy!.stopLowerPriority).toBe(true);
    expect(withoutPolicy!.stopLowerPriority).toBe(true);
    expect(policyOff!.stopLowerPriority).toBe(false);
  });

  it("derives targetProductIds from product and gift rewards, null when any reward is sitewide or none exist", () => {
    const [targeted, sitewide, gifts, none, mixed] = buildPlanUnits(
      [
        { offerId: "a", offer: offer({ productRewards: [productReward({ targetProductIds: ["p2", "p1"] }), productReward({ targetProductIds: ["p1", "p3"] })] }) },
        { offerId: "b", offer: offer({ productRewards: [productReward({ targetProductIds: [] })] }) },
        { offerId: "c", offer: offer({ giftRewards: [{ id: "g", targetProductIds: ["g1"], targetVariantIds: [] } as never] }) },
        { offerId: "d", offer: offer() },
        { offerId: "e", offer: offer({ productRewards: [productReward()], giftRewards: [{ id: "g", targetProductIds: [], targetVariantIds: ["v"] } as never] }) },
      ],
      [],
      [],
    );
    expect(targeted!.targetProductIds).toEqual(["p1", "p2", "p3"]);
    expect(sitewide!.targetProductIds).toBeNull();
    expect(gifts!.targetProductIds).toEqual(["g1"]);
    expect(none!.targetProductIds).toBeNull();
    expect(mixed!.targetProductIds).toBeNull();
  });

  it("marks quiz_bundle product rewards as multi-line fixed", () => {
    const [quiz, plain] = buildPlanUnits(
      [
        { offerId: "q", offer: offer({ productRewards: [productReward({ scopeMode: "quiz_bundle" })] }) },
        { offerId: "p", offer: offer({ productRewards: [productReward()] }) },
      ],
      [],
      [],
    );
    expect(quiz!.multiLineFixed).toBe(true);
    expect(plain!.multiLineFixed).toBe(false);
  });
});
