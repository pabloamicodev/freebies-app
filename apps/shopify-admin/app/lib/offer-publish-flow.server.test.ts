import { describe, expect, it } from "vitest";
import { offers, offerConditions, offerRewards, discountCodes, type Db } from "@promo/db";
import {
  hasUnenforcedScopeFilter,
  isConditionEnforcedByFunction,
  isUnscopedTaggedReward,
  validateOffersPublishable,
} from "./offer-publish-flow.server.js";

interface FakeOfferRow {
  id: string;
  internalName: string;
  requiredDiscountCode: string | null;
  requiresCode?: boolean;
}

function fakeDb(rows: {
  offerRows: FakeOfferRow[];
  conditionRows?: unknown[];
  rewardRows?: unknown[];
  codeRows?: Array<{ offerId: string }>;
}): Db {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === offers) return Promise.resolve(rows.offerRows);
          if (table === offerConditions) return Promise.resolve(rows.conditionRows ?? []);
          if (table === offerRewards) return Promise.resolve(rows.rewardRows ?? []);
          if (table === discountCodes) return Promise.resolve(rows.codeRows ?? []);
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return db as unknown as Db;
}

const validGiftReward = {
  id: "r1",
  offerId: "offer-1",
  rewardType: "product_gift",
  discountType: "percentage",
  value: { amount: 10 },
  target: { productId: "gid://shopify/Product/1" },
  quantity: 1,
  isAutoAdd: false,
  isCustomerSelectable: false,
  sortOrder: 0,
  label: null,
};

describe("isConditionEnforcedByFunction", () => {
  it.each([
    "cart_value",
    "cart_quantity",
    "specific_product",
    "pack_of_products",
    "subscription_product_type",
    "order_history_total_orders",
    "order_history_total_spent",
    "line_attribute",
    "cart_attribute",
    "exclude_products",
    "customer_tags",
    "customer_location",
    "markets",
    "specific_link",
    "page_url",
  ])("allows Function-enforced condition %s", (conditionType) => {
    expect(isConditionEnforcedByFunction(conditionType)).toBe(true);
  });

  it.each([
    "one_use_per_customer",
    "sales_channels",
    "exclude_collections",
    "exclude_vendors",
    "exclude_types",
    "discount_code",
  ])("fails closed for storefront-only condition %s", (conditionType) => {
    expect(isConditionEnforcedByFunction(conditionType)).toBe(false);
  });
});

describe("isUnscopedTaggedReward", () => {
  it("flags quiz_bundle and tagged_offer product rewards with no product/variant allowlist", () => {
    expect(isUnscopedTaggedReward("product_discount", { scopeMode: "quiz_bundle" })).toBe(true);
    expect(
      isUnscopedTaggedReward("bundle_discount", {
        scopeMode: "tagged_offer",
        requiredOfferId: "11111111-1111-1111-1111-111111111111",
      }),
    ).toBe(true);
  });

  it("allows quiz_bundle/tagged_offer rewards once they have a product or variant allowlist", () => {
    expect(
      isUnscopedTaggedReward("product_discount", {
        scopeMode: "quiz_bundle",
        productIds: ["gid://shopify/Product/1"],
      }),
    ).toBe(false);
    expect(
      isUnscopedTaggedReward("upsell_discount", {
        scopeMode: "tagged_offer",
        variantId: "gid://shopify/ProductVariant/1",
      }),
    ).toBe(false);
  });

  it("ignores other scope modes and reward types — landing anchors are enforced elsewhere", () => {
    expect(isUnscopedTaggedReward("product_discount", { scopeMode: "sitewide" })).toBe(false);
    expect(isUnscopedTaggedReward("product_discount", { scopeMode: "landing" })).toBe(false);
    expect(isUnscopedTaggedReward("product_gift", { scopeMode: "quiz_bundle" })).toBe(false);
    expect(isUnscopedTaggedReward("shipping_discount", { scopeMode: "quiz_bundle" })).toBe(false);
  });
});

describe("validateOffersPublishable — required discount code", () => {
  it("still requires an enabled main condition for a regular offer", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Regular Offer", requiredDiscountCode: null }],
      rewardRows: [validGiftReward],
    });

    const result = await validateOffersPublishable(db, "shop-1", ["offer-1"]);

    expect(result).toEqual({
      ok: false,
      error: 'Cannot publish "Regular Offer": add at least one enabled main condition.',
    });
  });

  it("allows a code-gated offer to publish with zero enabled main conditions", async () => {
    const db = fakeDb({
      offerRows: [
        { id: "offer-1", internalName: "Prime Day", requiredDiscountCode: "PRIMEDAY2026" },
      ],
      rewardRows: [validGiftReward],
    });

    const result = await validateOffersPublishable(db, "shop-1", ["offer-1"]);

    expect(result).toEqual({ ok: true });
  });

  it("still requires a reward even for a code-gated offer", async () => {
    const db = fakeDb({
      offerRows: [
        { id: "offer-1", internalName: "Prime Day", requiredDiscountCode: "PRIMEDAY2026" },
      ],
      rewardRows: [],
    });

    const result = await validateOffersPublishable(db, "shop-1", ["offer-1"]);

    expect(result).toEqual({
      ok: false,
      error: 'Cannot publish "Prime Day": add at least one reward.',
    });
  });

  const shippingReward = {
    ...validGiftReward,
    rewardType: "shipping_discount",
    discountType: "free",
    value: { amount: 100 },
    target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE"] },
  };

  it("allows a shipping-only offer gated by a legacy required code (its node runs the delivery Function)", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Ship", requiredDiscountCode: "FREESHIP" }],
      rewardRows: [shippingReward],
    });

    expect(await validateOffersPublishable(db, "shop-1", ["offer-1"])).toEqual({ ok: true });
  });

  it("allows a shipping-only offer gated by its own discount codes, with no main condition", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Ship", requiredDiscountCode: null }],
      rewardRows: [shippingReward],
      codeRows: [{ offerId: "offer-1" }],
    });

    expect(await validateOffersPublishable(db, "shop-1", ["offer-1"])).toEqual({ ok: true });
  });

  it("allows mixing shipping with other rewards on a code offer: shipping is gated in the delivery config", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Prime Day", requiredDiscountCode: null, requiresCode: false }],
      rewardRows: [validGiftReward, shippingReward],
      codeRows: [{ offerId: "offer-1" }],
    });

    expect(await validateOffersPublishable(db, "shop-1", ["offer-1"])).toEqual({ ok: true });
  });

  it("treats a requiresCode offer with no codes as code-gated (no main condition needed, never ungated)", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Copy", requiredDiscountCode: null, requiresCode: true }],
      rewardRows: [validGiftReward],
    });

    expect(await validateOffersPublishable(db, "shop-1", ["offer-1"])).toEqual({ ok: true });
  });

  it("still rejects unsupported conditions on a shipping code offer", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Ship", requiredDiscountCode: null }],
      rewardRows: [shippingReward],
      codeRows: [{ offerId: "offer-1" }],
      conditionRows: [
        { offerId: "offer-1", scope: "main", isEnabled: true, conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 1 } },
      ],
    });

    const result = await validateOffersPublishable(db, "shop-1", ["offer-1"]);

    expect(result.error).toMatch(/shipping discounts do not yet support the cart_quantity condition/);
  });

  it("blocks a legacy discount_code condition with a pointer to the Codes tab instead of publishing it ungated", async () => {
    const db = fakeDb({
      offerRows: [{ id: "offer-1", internalName: "Legacy", requiredDiscountCode: null }],
      rewardRows: [validGiftReward],
      conditionRows: [
        { offerId: "offer-1", scope: "main", isEnabled: true, conditionType: "discount_code", operator: "eq", value: { code: "PRIME" } },
      ],
    });

    const result = await validateOffersPublishable(db, "shop-1", ["offer-1"]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Codes tab/);
  });
});

describe("hasUnenforcedScopeFilter", () => {
  it("allows no filter or product exclusions only", () => {
    expect(hasUnenforcedScopeFilter({ thresholdCents: 5000 })).toBe(false);
    expect(hasUnenforcedScopeFilter({ scopeFilter: { excludeProductIds: ["p1"], productIds: [] } })).toBe(false);
  });
  it("rejects inclusion or collection/vendor scopes checkout cannot enforce", () => {
    expect(hasUnenforcedScopeFilter({ scopeFilter: { collectionIds: ["c1"] } })).toBe(true);
    expect(hasUnenforcedScopeFilter({ scopeFilter: { vendors: ["Acme"] } })).toBe(true);
  });
});
