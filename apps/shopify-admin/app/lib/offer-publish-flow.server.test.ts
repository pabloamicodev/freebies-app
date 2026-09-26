import { describe, expect, it } from "vitest";
import { hasUnenforcedScopeFilter, isConditionEnforcedByFunction, isUnscopedTaggedReward } from "./offer-publish-flow.server.js";

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
