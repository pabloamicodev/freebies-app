import { describe, it, expect } from "vitest";
import { evaluateSubscriptionCondition } from "./subscription.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ requiresSellingPlan: boolean; sellingPlanId: string | null }>): NormalizedCart {
  return {
    token: "t", id: null,
    lines: lines.map((l, i) => ({
      key: `k${i}`, variantId: `v${i}`, productId: `p${i}`,
      quantity: 1, priceCents: 2000, compareAtPriceCents: null,
      properties: {},
      requiresSellingPlan: l.requiresSellingPlan,
      sellingPlanId: l.sellingPlanId,
      productHandle: "p", productTitle: "P", variantTitle: null,
      vendor: "V", productType: "T", tags: [], collections: [],
      availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
    })),
    subtotalCents: 0, discountCodes: [], currencyCode: "USD", totalQuantity: lines.length,
  };
}

describe("evaluateSubscriptionCondition", () => {
  it("passes 'any' mode always", () => {
    const cart = makeCart([{ requiresSellingPlan: false, sellingPlanId: null }]);
    expect(evaluateSubscriptionCondition(cart, { mode: "any" }).ok).toBe(true);
  });

  it("passes subscription_only when cart has subscription line", () => {
    const cart = makeCart([
      { requiresSellingPlan: true, sellingPlanId: "sp-123" },
    ]);
    expect(evaluateSubscriptionCondition(cart, { mode: "subscription_only" }).ok).toBe(true);
  });

  it("fails subscription_only when cart has only one-time lines", () => {
    const cart = makeCart([{ requiresSellingPlan: false, sellingPlanId: null }]);
    expect(evaluateSubscriptionCondition(cart, { mode: "subscription_only" }).ok).toBe(false);
  });

  it("passes one_time_only when cart has only one-time lines", () => {
    const cart = makeCart([{ requiresSellingPlan: false, sellingPlanId: null }]);
    expect(evaluateSubscriptionCondition(cart, { mode: "one_time_only" }).ok).toBe(true);
  });

  it("fails one_time_only when cart has subscription line", () => {
    const cart = makeCart([{ requiresSellingPlan: true, sellingPlanId: "sp-123" }]);
    expect(evaluateSubscriptionCondition(cart, { mode: "one_time_only" }).ok).toBe(false);
  });
});
