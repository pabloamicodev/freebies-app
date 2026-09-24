import { describe, expect, it } from "vitest";
import { isConditionEnforcedByFunction } from "./offer-publish-flow.server.js";

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
  ])("allows Function-enforced condition %s", (conditionType) => {
    expect(isConditionEnforcedByFunction(conditionType)).toBe(true);
  });

  it.each([
    "specific_link",
    "page_url",
    "markets",
    "one_use_per_customer",
    "sales_channels",
    "exclude_collections",
    "exclude_vendors",
    "exclude_types",
  ])("fails closed for storefront-only condition %s", (conditionType) => {
    expect(isConditionEnforcedByFunction(conditionType)).toBe(false);
  });
});
