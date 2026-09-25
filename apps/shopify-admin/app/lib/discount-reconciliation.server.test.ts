import { describe, expect, it, vi } from "vitest";
import {
  executeDiscountNodeReconciliation,
  needsDiscountReconciliation,
} from "./discount-reconciliation.server.js";

describe("needsDiscountReconciliation", () => {
  it("retries partial publications even after both discount IDs were persisted", () => {
    expect(
      needsDiscountReconciliation({
        discountId: "gid://shopify/DiscountAutomaticNode/cart",
        deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/shipping",
        compiledConfig: null,
      }),
    ).toBe(true);
  });

  it("skips only a fully provisioned and compiled active offer", () => {
    expect(
      needsDiscountReconciliation({
        discountId: "gid://shopify/DiscountAutomaticNode/cart",
        deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/shipping",
        compiledConfig: { version: "1" },
      }),
    ).toBe(false);
  });
});

describe("executeDiscountNodeReconciliation", () => {
  it("deduplicates stores, publishes sequentially, and reports isolated failures", async () => {
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === "shop-2") throw new Error("remote mutation failed");
    });

    const result = await executeDiscountNodeReconciliation(
      [
        { shopId: "shop-1", shopDomain: "one.myshopify.com" },
        { shopId: "shop-1", shopDomain: "one.myshopify.com" },
        { shopId: "shop-2", shopDomain: "two.myshopify.com" },
      ],
      publish,
    );

    expect(publish).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      failures: [{ shopId: "shop-2", error: "remote mutation failed" }],
    });
  });
});
