import { describe, expect, it } from "vitest";
import { buildRewardRecord } from "./reward-record.server.js";

const tiers = [
  { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 15, cartLabels: ["Starter"] },
  { minimumQuantity: 2, discountType: "percentage", discountValue: 20 },
];

function productDiscountForm(): FormData {
  const form = new FormData();
  form.set("rewardType", "product_discount");
  form.set("discountType", "percentage");
  form.set("discountValue", "10");
  form.set("productScopeMode", "sitewide");
  return form;
}

describe("buildRewardRecord product_discount", () => {
  it("keeps only the existing tiers when the form carries none", async () => {
    const built = await buildRewardRecord(productDiscountForm(), {} as never, "shop", "USD", {
      rewardType: "product_discount",
      value: { amount: 5, currencyCode: "USD", tiers, stale: "dropped" },
    });
    expect(built).toHaveProperty("data");
    if ("error" in built) throw new Error(built.error);
    expect(built.data.value).toEqual({ amount: 10, currencyCode: "USD", tiers });
  });

  it("leaves no keys of the old reward when it was not a product discount", async () => {
    const built = await buildRewardRecord(productDiscountForm(), {} as never, "shop", "USD", {
      rewardType: "product_gift",
      value: { amount: 100, currencyCode: "USD", tiers, giftKey: "x" },
    });
    if ("error" in built) throw new Error(built.error);
    expect(built.data.value).toEqual({ amount: 10, currencyCode: "USD" });
  });

  it("builds a plain value when there is nothing to preserve", async () => {
    const built = await buildRewardRecord(productDiscountForm(), {} as never, "shop", "USD");
    if ("error" in built) throw new Error(built.error);
    expect(built.data.value).toEqual({ amount: 10, currencyCode: "USD" });
  });
});
