import { describe, expect, it, vi } from "vitest";
import { executeDiscountNodeReconciliation } from "./discount-reconciliation.server.js";

describe("executeDiscountNodeReconciliation", () => {
  it("deduplicates stores, publishes sequentially, and reports isolated failures", async () => {
    const publish = vi.fn(async (shopId: string) => {
      if (shopId === "shop-2") throw new Error("remote mutation failed");
    });

    const result = await executeDiscountNodeReconciliation([
      { shopId: "shop-1", shopDomain: "one.myshopify.com" },
      { shopId: "shop-1", shopDomain: "one.myshopify.com" },
      { shopId: "shop-2", shopDomain: "two.myshopify.com" },
    ], publish);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      failures: [{ shopId: "shop-2", error: "remote mutation failed" }],
    });
  });
});
