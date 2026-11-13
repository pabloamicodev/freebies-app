import { describe, expect, it } from "vitest";
import { buildRewardRecord, buildRewardRecordFromInput, rewardInputFromFormData, type RewardInput } from "./reward-record.server.js";

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

describe("FormData adapter and typed core store the same row", () => {
  const formOf = (fields: Record<string, string | string[]>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
    return form;
  };
  /** Same reward through both entry points; they must agree on the whole outcome, errors included. */
  async function bothWays(fields: Record<string, string | string[]>, input: RewardInput, existing?: { rewardType: string; value: unknown }) {
    const viaForm = await buildRewardRecord(formOf(fields), {} as never, "shop", "USD", existing);
    const viaTyped = await buildRewardRecordFromInput(input, {} as never, "shop", "USD", existing);
    expect(viaTyped).toEqual(viaForm);
    return viaTyped;
  }

  it("quantity tiers (and the old tiers kept when an edit posts none)", async () => {
    const result = await bothWays(
      { rewardType: "product_discount", discountType: "percentage", productScopeMode: "sitewide", productTiers: JSON.stringify(tiers), variantGids: "gid://shopify/Product/9", productTargetType: "products" },
      { rewardType: "product_discount", discountType: "percentage", productScopeMode: "sitewide", productTiers: tiers, pickerGids: ["gid://shopify/Product/9"], productTargetType: "products" },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.data.value).toEqual({ amount: 0, currencyCode: "USD", tiers });
    expect(result.data.target).toMatchObject({ productIds: ["gid://shopify/Product/9"], selectionLevel: "product", scopeMode: "sitewide" });
    const kept = await bothWays(
      { rewardType: "product_discount", discountType: "percentage", discountValue: "10", productScopeMode: "sitewide" },
      { rewardType: "product_discount", discountType: "percentage", discountValue: 10, productScopeMode: "sitewide" },
      { rewardType: "product_discount", value: { tiers } },
    );
    if ("error" in kept) throw new Error(kept.error);
    expect(kept.data.value).toEqual({ amount: 10, currencyCode: "USD", tiers });
  });

  it("cheapest item free", async () => {
    const result = await bothWays(
      { rewardType: "product_discount", discountType: "cheapest_item_free", productScopeMode: "sitewide", maxUnitsTotal: "2", subscriptionMode: "one_time_only" },
      { rewardType: "product_discount", discountType: "cheapest_item_free", productScopeMode: "sitewide", maxUnitsTotal: 2, subscriptionMode: "one_time_only" },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.data.target).toMatchObject({ maxUnitsTotal: 2, subscriptionMode: "one_time_only" });
  });

  it("cart tiers: order discount with a purchase type", async () => {
    const result = await bothWays(
      { rewardType: "order_discount", discountType: "fixed_amount", discountValue: "12.5", subscriptionMode: "subscription_only", label: " Spring " },
      { rewardType: "order_discount", discountType: "fixed_amount", discountValue: 12.5, subscriptionMode: "subscription_only", label: " Spring " },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.data).toMatchObject({ value: { amount: 1250, currencyCode: "USD" }, target: { subscriptionMode: "subscription_only" }, label: "Spring" });
  });

  it("fixed price", async () => {
    const result = await bothWays(
      { rewardType: "product_discount", discountType: "fixed_price", discountValue: "19.99", productScopeMode: "sitewide", lineQuantityEquals: "2" },
      { rewardType: "product_discount", discountType: "fixed_price", discountValue: 19.99, productScopeMode: "sitewide", lineQuantityEquals: 2 },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.data.value).toEqual({ amount: 1999, currencyCode: "USD" });
    expect(result.data.target).toMatchObject({ lineQuantityEquals: 2 });
  });

  it("shipping tiers, sitewide and landing", async () => {
    const shippingTiers = [
      { minimumSubtotalCents: 0, maximumSubtotalCents: 4999, discountType: "percentage", discountValue: 50 },
      { minimumSubtotalCents: 5000, discountType: "percentage", discountValue: 100 },
    ];
    const sitewide = await bothWays(
      { rewardType: "shipping_discount", discountType: "free", shippingTiers: JSON.stringify(shippingTiers), deliveryGroupTypes: ["ONE_TIME_PURCHASE"], shippingScopeMode: "sitewide" },
      { rewardType: "shipping_discount", discountType: "free", shippingTiers, deliveryGroupTypes: ["ONE_TIME_PURCHASE"], shippingScopeMode: "sitewide" },
    );
    if ("error" in sitewide) throw new Error(sitewide.error);
    expect(sitewide.data).toMatchObject({ discountType: "percentage", value: { amount: 50, tiers: shippingTiers }, target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE"], scopeMode: "sitewide" } });
    const landing = await bothWays(
      { rewardType: "shipping_discount", discountType: "free", shippingTiers: JSON.stringify(shippingTiers), deliveryGroupTypes: ["SUBSCRIPTION"], shippingScopeMode: "landing", requiredLineAttributeValue: " lp ", requiredAnchorVariantIds: "gid://shopify/ProductVariant/1\ngid://shopify/ProductVariant/2", requiredAnchorMinQuantity: "2", requiresAnchorSubscription: "on" },
      { rewardType: "shipping_discount", discountType: "free", shippingTiers, deliveryGroupTypes: ["SUBSCRIPTION"], shippingScopeMode: "landing", requiredLineAttributeValue: " lp ", requiredAnchorVariantIds: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"], requiredAnchorMinQuantity: 2, requiresAnchorSubscription: true },
    );
    if ("error" in landing) throw new Error(landing.error);
    expect(landing.data.target).toMatchObject({ scopeMode: "landing", requiredLineAttributeValue: "lp", requiredAnchorMinQuantity: 2, requiresAnchorSubscription: true });
  });

  it("gift tier subtotal: absent keeps, blank clears (null), a number is passed through", () => {
    expect(rewardInputFromFormData(formOf({ rewardType: "product_gift" })).input).not.toHaveProperty("minCartSubtotal");
    expect(rewardInputFromFormData(formOf({ rewardType: "product_gift", minCartSubtotal: " " })).input).toMatchObject({ minCartSubtotal: null });
    expect(rewardInputFromFormData(formOf({ rewardType: "product_gift", minCartSubtotal: "49.5" })).input).toMatchObject({ minCartSubtotal: 49.5 });
  });

  it("both entry points report the same validation errors", async () => {
    const cases: Array<[Record<string, string | string[]>, RewardInput, string]> = [
      [{ rewardType: "order_discount", discountType: "percentage", discountValue: "150" }, { rewardType: "order_discount", discountType: "percentage", discountValue: 150 }, "Percentage discount cannot exceed 100%."],
      [{ rewardType: "order_discount", discountType: "fixed_amount", discountValue: "abc" }, { rewardType: "order_discount", discountType: "fixed_amount", discountValue: Number.NaN }, "Discount value must be a valid non-negative number."],
      [{ rewardType: "order_discount", discountType: "fixed_amount", discountValue: "5", quantity: "999" }, { rewardType: "order_discount", discountType: "fixed_amount", discountValue: 5, quantity: 999 }, "Quantity must be a whole number between 1 and 250."],
      [{ rewardType: "shipping_discount", discountType: "free" }, { rewardType: "shipping_discount", discountType: "free" }, "Configure at least one shipping tier."],
      [{ rewardType: "product_discount", discountType: "percentage", productScopeMode: "sitewide", productTiers: JSON.stringify([tiers[1], tiers[0]]) }, { rewardType: "product_discount", discountType: "percentage", productScopeMode: "sitewide", productTiers: [tiers[1], tiers[0]] }, "Tier 2 overlaps the tier before it: tiers must be in ascending order without overlapping quantities."],
      [{ rewardType: "product_discount", discountType: "percentage", discountValue: "5" }, { rewardType: "product_discount", discountType: "percentage", discountValue: 5 }, "Product discount scope is invalid."],
    ];
    for (const [fields, input, message] of cases) {
      const result = await bothWays(fields, input);
      expect(result).toEqual({ error: message });
    }
  });

  it("invalid JSON posted by the form stays a form-level error", async () => {
    const shipping = await buildRewardRecord(formOf({ rewardType: "shipping_discount", discountType: "free", shippingTiers: "{nope" }), {} as never, "shop", "USD");
    expect(shipping).toEqual({ error: "Shipping tiers must be valid JSON." });
    const prices = await buildRewardRecord(
      formOf({ rewardType: "product_discount", discountType: "percentage", discountValue: "5", productScopeMode: "sitewide", productPriceTiers: "{nope" }),
      {} as never,
      "shop",
      "USD",
    );
    expect(prices).toEqual({ error: "Product price tiers must be valid JSON." });
  });
});
