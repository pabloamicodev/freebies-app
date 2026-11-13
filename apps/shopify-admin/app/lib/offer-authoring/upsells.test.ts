import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { variantCache, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../test-support/pglite-db.js";
import {
  toStoredUpsellConditions,
  toStoredUpsellRewards,
  upsellAfterInsert,
  upsellCombinationPolicy,
  type AuthoringUpsellReward,
} from "./upsells.js";
import type { AuthoringDeps } from "./types.js";

let db: Db;
let close: () => Promise<void>;
let deps: AuthoringDeps;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const shopId = await seedShop(db);
  deps = { db, shopId, shopDomain: "test-shop.myshopify.com", shopCurrency: "USD", timezone: "UTC" };
  await db.insert(variantCache).values([
    { shopId, variantGid: "gid://shopify/ProductVariant/11", productGid: "gid://shopify/Product/10", title: "A", price: "10.00", currencyCode: "USD", availableForSale: true, raw: {} },
    { shopId, variantGid: "gid://shopify/ProductVariant/12", productGid: "gid://shopify/Product/10", title: "B", price: "10.00", currencyCode: "USD", availableForSale: true, raw: {} },
  ] as never);
}, 60_000);
afterAll(async () => {
  await close();
});

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rewards = async (input: AuthoringUpsellReward) => {
  const r = await toStoredUpsellRewards([input], deps);
  if (!r.ok) throw new Error(r.error);
  return json(r.value);
};
const conditions = (input: AuthoringUpsellReward, subs = []) => {
  const r = toStoredUpsellConditions([input], deps, subs);
  if (!r.ok) throw new Error(r.error);
  return json(r.value);
};

describe("checkout upsell", () => {
  const base: AuthoringUpsellReward = {
    kind: "upsell_discount",
    template: "checkout",
    checkoutTarget: "cart",
    upsellProducts: ["gid://shopify/ProductVariant/99"],
    discountValue: 15,
  };

  it("reward equals the wizard row (upsell.$template.tsx:241-265)", async () => {
    expect(await rewards(base)).toEqual([
      {
        rewardType: "upsell_discount",
        discountType: "percentage",
        value: { amount: 15, currencyCode: "USD" },
        target: { scopeMode: "sitewide", scope: "cart", productIds: [], variantIds: ["gid://shopify/ProductVariant/99"] },
        isAutoAdd: false,
        isCustomerSelectable: true,
        trackMode: "product",
        sortOrder: 0,
      },
    ]);
  });

  it("fixed amounts are stored in minor units and subscription mode lands in the target (:144-149, :254)", async () => {
    const [r] = await rewards({ ...base, discountType: "fixed_amount", discountValue: 4.5, subscriptionMode: "subscription_only", upsellProducts: ["77"] });
    expect(r).toMatchObject({ discountType: "fixed_amount", value: { amount: 450, currencyCode: "USD" } });
    expect(r!.target).toMatchObject({ subscriptionMode: "subscription_only", productIds: ["gid://shopify/Product/77"] });
  });

  it("always trigger: main cart_quantity gte 1 plus visibility row (:180-211)", () => {
    expect(conditions(base)).toEqual([
      { scope: "main", conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1, includeGiftValues: false }, sortOrder: 0, isEnabled: true },
      {
        scope: "visibility",
        conditionType: "sales_channels",
        operator: "eq",
        value: { upsellType: "checkout", triggerType: "always", upsellMethod: "manual", checkoutTarget: "cart" },
        sortOrder: 1,
        isEnabled: true,
      },
    ]);
  });

  it("policy defaults combine with order and shipping discounts (:266-275, :114-115)", () => {
    expect(upsellCombinationPolicy({ combinesWithOrderDiscounts: true, combinesWithShippingDiscounts: true })).toMatchObject({
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true,
      combinesWithOtherAppOffers: true,
      stopLowerPriority: false,
      giftValueCountsForOtherOffers: false,
    });
  });
});

describe("frequently bought together", () => {
  const fbt: AuthoringUpsellReward = {
    kind: "upsell_discount",
    template: "fbt",
    widgetType: "product_add_on",
    triggerType: "product_selected",
    triggerProducts: ["gid://shopify/Product/5", "gid://shopify/ProductVariant/6"],
    triggerMatchRule: "all",
    upsellProducts: ["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/12"],
    upsellWholeProducts: ["gid://shopify/Product/10"],
    discountEnabled: true,
    discountMinProducts: 3,
    discountApplyTo: "cheapest",
    allowCustomerQty: true,
    discountValue: 20,
  };

  it("collapses whole products to the product id with selectionLevel (:122, :257-259)", async () => {
    const [r] = await rewards(fbt);
    expect(r!.target).toEqual({ scopeMode: "sitewide", scope: "cart", productIds: ["gid://shopify/Product/10"], variantIds: [], selectionLevel: "product" });
    expect(r!.value).toEqual({ amount: 20, currencyCode: "USD" });
  });

  it("discount disabled stores amount 0 (:144-145)", async () => {
    const [r] = await rewards({ ...fbt, discountEnabled: false });
    expect(r!.value).toEqual({ amount: 0, currencyCode: "USD" });
  });

  it("positive trigger builds specific_product requirements with the match operator and the fbt visibility metadata (:150-155, :180-211)", () => {
    const rows = conditions(fbt);
    expect(rows[0]).toEqual({
      scope: "main",
      conditionType: "specific_product",
      operator: "gte",
      value: {
        requirements: [
          { productId: "gid://shopify/Product/5", trackMode: "product", minQuantity: 1 },
          { variantId: "gid://shopify/ProductVariant/6", trackMode: "variant", minQuantity: 1 },
        ],
        multiplyByGroups: false,
      },
      sortOrder: 0,
      isEnabled: true,
    });
    expect(rows[1]!.value).toEqual({
      upsellType: "fbt",
      triggerType: "product_selected",
      upsellMethod: "manual",
      widgetType: "product_add_on",
      allowCustomerQty: true,
      discountEnabled: true,
      discountMinProducts: 3,
      discountApplyTo: "cheapest",
    });
    expect(conditions({ ...fbt, triggerMatchRule: "any" })[0]!.operator).toBe("any");
  });

  it("product_except adds an exclude_products row after the subconditions (:224-239)", () => {
    const sub = { scope: "sub", conditionType: "customer_tags", operator: "in", value: { tags: ["vip"] } } as never;
    const rows = conditions({ ...fbt, triggerType: "product_except" }, [sub]);
    expect(rows.map((r) => [r.scope, r.conditionType, r.sortOrder])).toEqual([
      ["main", "cart_quantity", 0],
      ["visibility", "sales_channels", 1],
      ["sub", "customer_tags", 2],
      ["sub", "exclude_products", 3],
    ]);
    expect(rows[3]!.value).toEqual({ productIds: ["gid://shopify/Product/5"], variantIds: ["gid://shopify/ProductVariant/6"] });
  });
});

describe("thank-you upsell and validation", () => {
  it("thank_you carries only the generic visibility metadata", () => {
    const rows = conditions({ kind: "upsell_discount", template: "thank_you", upsellMethod: "random", upsellProducts: ["gid://shopify/Product/1"] });
    expect(rows[1]!.value).toEqual({ upsellType: "thank_you", triggerType: "always", upsellMethod: "random" });
  });

  it("publish checks use the wizard messages (:123-135)", async () => {
    expect(await toStoredUpsellRewards([{ kind: "upsell_discount", forPublish: true }], deps)).toMatchObject({ ok: false, error: "Select at least one upsell product before publishing." });
    expect(
      await toStoredUpsellRewards([{ kind: "upsell_discount", forPublish: true, upsellProducts: ["1"], triggerType: "product" }], deps),
    ).toMatchObject({ ok: false, error: "Select at least one trigger product before publishing." });
  });

  it("rejects a percentage above 100 and a second reward", async () => {
    expect(await toStoredUpsellRewards([{ kind: "upsell_discount", discountValue: 101 }], deps)).toMatchObject({ ok: false });
    const one: AuthoringUpsellReward = { kind: "upsell_discount" };
    expect(await toStoredUpsellRewards([one, one], deps)).toMatchObject({ ok: false });
  });

  it("upsellAfterInsert is a no-op", async () => {
    await expect(upsellAfterInsert([{ kind: "upsell_discount" }], deps)(undefined, "x")).resolves.toBeUndefined();
  });
});
