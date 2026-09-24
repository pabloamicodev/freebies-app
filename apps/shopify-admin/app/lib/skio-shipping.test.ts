import { describe, expect, it } from "vitest";
import { skioShippingTiersConfigSchema, type SkioShippingTier } from "./skio-shipping-tiers.js";
import { resolveShippingOverride, resolveShippingOverrides, type SkioSubscriptionSnapshot } from "./skio-shipping-sync.js";

const VARIANT_A = "gid://shopify/ProductVariant/1";
const VARIANT_B = "gid://shopify/ProductVariant/2";

function tier(overrides: Partial<SkioShippingTier> = {}): SkioShippingTier {
  return {
    id: "two-month-under-50",
    name: "Two months under $50",
    subscriptionDurationMonths: 2,
    minSubtotal: 0,
    maxSubtotal: 50,
    productVariantIds: null,
    cycleOverrides: [{ cycle: 1, override: { amount: null } }],
    defaultOverride: { amount: 1.99 },
    ...overrides,
  };
}

function subscription(overrides: Partial<SkioSubscriptionSnapshot> = {}): SkioSubscriptionSnapshot {
  return {
    id: "sub-1",
    subscriptionDurationMonths: 2,
    subtotal: 30,
    cyclesCompleted: 0,
    productVariantIds: [VARIANT_A],
    ...overrides,
  };
}

describe("Skio shipping tiers", () => {
  it("leaves cycle one unchanged and charges the configured default afterward", () => {
    const config = { tiers: [tier()] };
    expect(resolveShippingOverride(config, subscription({ cyclesCompleted: 0 }))).toMatchObject({
      targetCycle: 1,
      matchedTierId: "two-month-under-50",
      overrideAmount: null,
    });
    expect(resolveShippingOverride(config, subscription({ cyclesCompleted: 1 }))).toMatchObject({
      targetCycle: 2,
      overrideAmount: 1.99,
    });
  });

  it("supports free shipping and explicit per-cycle ladders", () => {
    const config = {
      tiers: [tier({
        id: "three-month-over-50",
        subscriptionDurationMonths: 3,
        minSubtotal: 50,
        maxSubtotal: null,
        cycleOverrides: [
          { cycle: 1, override: { amount: 0 } },
          { cycle: 3, override: { amount: 0.99 } },
        ],
      })],
    };
    const base = { subscriptionDurationMonths: 3, subtotal: 60 };
    expect(resolveShippingOverride(config, subscription({ ...base, cyclesCompleted: 0 })).overrideAmount).toBe(0);
    expect(resolveShippingOverride(config, subscription({ ...base, cyclesCompleted: 1 })).overrideAmount).toBe(1.99);
    expect(resolveShippingOverride(config, subscription({ ...base, cyclesCompleted: 2 })).overrideAmount).toBe(0.99);
  });

  it("uses inclusive minimums, exclusive maximums, and first-match priority", () => {
    const config = {
      tiers: [
        tier({ id: "first", minSubtotal: 0, maxSubtotal: 50 }),
        tier({ id: "second", minSubtotal: 0, maxSubtotal: 100 }),
      ],
    };
    expect(resolveShippingOverride(config, subscription({ subtotal: 49.99 })).matchedTierId).toBe("first");
    expect(resolveShippingOverride(config, subscription({ subtotal: 50 })).matchedTierId).toBe("second");
  });

  it("filters tiers by product variant when configured", () => {
    const config = { tiers: [tier({ productVariantIds: [VARIANT_B] })] };
    expect(resolveShippingOverride(config, subscription({ productVariantIds: [VARIANT_A] })).matchedTierId).toBeNull();
    expect(resolveShippingOverride(config, subscription({ productVariantIds: [VARIANT_A, VARIANT_B] })).matchedTierId).toBe("two-month-under-50");
  });

  it("resolves batches independently without changing their order", () => {
    const decisions = resolveShippingOverrides({ tiers: [tier()] }, [
      subscription({ id: "sub-a" }),
      subscription({ id: "sub-b", subscriptionDurationMonths: 6 }),
    ]);
    expect(decisions.map((decision) => decision.subscriptionId)).toEqual(["sub-a", "sub-b"]);
    expect(decisions[1]?.matchedTierId).toBeNull();
  });

  it("rejects duplicate ids, duplicate cycle rows, and inverted ranges", () => {
    expect(skioShippingTiersConfigSchema.safeParse({ tiers: [tier(), tier()] }).success).toBe(false);
    expect(skioShippingTiersConfigSchema.safeParse({
      tiers: [tier({ cycleOverrides: [
        { cycle: 1, override: { amount: 0 } },
        { cycle: 1, override: { amount: 1 } },
      ] })],
    }).success).toBe(false);
    expect(skioShippingTiersConfigSchema.safeParse({ tiers: [tier({ minSubtotal: 50, maxSubtotal: 50 })] }).success).toBe(false);
  });
});
