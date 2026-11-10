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

describe("buildRewardRecord product target level", () => {
  const picked = ["gid://shopify/Product/1", "gid://shopify/Product/2"];
  const withTargets = (targetType: string) => {
    const form = productDiscountForm();
    form.set("productTargetType", targetType);
    form.set("variantGids", picked.join("\n"));
    return form;
  };

  it("marks a selection saved as whole products, so the compiler may ship product ids", async () => {
    const built = await buildRewardRecord(withTargets("products"), {} as never, "shop", "USD");
    if ("error" in built) throw new Error(built.error);
    expect(built.data.target).toMatchObject({ productIds: picked, selectionLevel: "product" });
    expect(built.data.target).not.toHaveProperty("variantIds");
  });

  it("leaves a variant selection unmarked", async () => {
    const variants = ["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/22"];
    const form = withTargets("variants");
    form.set("variantGids", variants.join("\n"));
    const built = await buildRewardRecord(form, {} as never, "shop", "USD");
    if ("error" in built) throw new Error(built.error);
    expect(built.data.target).toMatchObject({ variantIds: variants });
    expect(built.data.target).not.toHaveProperty("selectionLevel");
  });
});
