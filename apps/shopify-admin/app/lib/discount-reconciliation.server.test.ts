import { describe, expect, it, vi } from "vitest";
import {
  executeDiscountNodeReconciliation,
  needsDiscountReconciliation,
} from "./discount-reconciliation.server.js";
import { ShardPlanBlockedError } from "./sync/cart-shards.server.js";

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

describe("executeDiscountNodeReconciliation with a blocked shard plan", () => {
  it("reports the structured capacity error with offer names, shop-scoped, and keeps going", async () => {
    const blocked = new ShardPlanBlockedError(
      { code: "OFFER_TOO_LARGE", unitKeys: ["11111111-1111-4111-8111-111111111111"], reason: "bytes", numbers: { bytes: 12000, slotBytes: 9500 } },
      { shardsEnabled: true, names: new Map([["11111111-1111-4111-8111-111111111111", "Huge quiz"]]) },
    );
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === "shop-1") throw blocked;
    });

    const result = await executeDiscountNodeReconciliation(
      [
        { shopId: "shop-1", shopDomain: "one.myshopify.com" },
        { shopId: "shop-2", shopDomain: "two.myshopify.com" },
      ],
      publish,
    );

    expect(publish).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toBe(1);
    expect(result.failures).toEqual([
      {
        shopId: "shop-1",
        error: blocked.message,
        capacity: { code: "OFFER_TOO_LARGE", offerIds: ["11111111-1111-4111-8111-111111111111"], numbers: { bytes: 12000, slotBytes: 9500 } },
      },
    ]);
    expect(blocked.message).toContain('"Huge quiz"');
    expect(blocked.message).not.toContain("11111111");
  });
});
