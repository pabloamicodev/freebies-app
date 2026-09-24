import { describe, expect, it } from "vitest";
import { normalizeGiftSubconditions } from "./gift-subconditions.js";

describe("normalizeGiftSubconditions", () => {
  it("translates every quick-builder id to canonical engine condition types", () => {
    const result = normalizeGiftSubconditions({
      link: { requiredUrl: "/pages/vip", paramName: "code", paramValue: "summer" },
      order_history: { metric: "total_orders", operator: "gte", threshold: 3 },
      customer_tags: { tags: "vip, wholesale", exclude: false, guest: true },
      location: { countries: "us, ca", exclude: false },
      subscription: { mode: "subscription" },
      sales_channel: { online: true, mobile: false, pos: true },
      markets: { marketIds: "gid://shopify/Market/1, gid://shopify/Market/2", exclude: true },
      custom_attribute: { scope: "line", key: "engraving_message", value: "VIP", matchMode: "equals", minMatchingQuantity: 2 },
      quantity_limit: {
        matchMode: "all",
        rules: [{ qty: 2, scope: "specific_products", operator: "at_least", productIds: ["gid://shopify/Product/1"] }],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((condition) => condition.conditionType)).toEqual([
      "specific_link",
      "order_history_total_orders",
      "customer_tags",
      "customer_location",
      "subscription_product_type",
      "sales_channels",
      "markets",
      "line_attribute",
      "specific_product",
    ]);
    expect(result.data[0]?.value).toEqual({ requiredUrl: "/pages/vip", paramName: "code", paramValue: "summer" });
    expect(result.data[1]?.value).toMatchObject({ type: "total_orders", value: 3 });
    expect(result.data[5]?.value).toEqual({ channels: ["online_store", "pos"] });
    expect(result.data[7]?.value).toEqual({ key: "engraving_message", value: "VIP", matchMode: "equals", minMatchingQuantity: 2 });
    expect(result.data[8]?.value).toEqual({
      requirements: [{ productId: "gid://shopify/Product/1", trackMode: "product", minQuantity: 2 }],
      multiplyByGroups: false,
    });
  });

  it("fails visibly instead of persisting unsupported ambiguous quantity rules", () => {
    const result = normalizeGiftSubconditions({
      quantity_limit: {
        matchMode: "any",
        rules: [{ qty: 2, scope: "specific_products", operator: "at_least", productIds: ["gid://shopify/Product/1"] }],
      },
    });

    expect(result).toEqual({
      success: false,
      error: "Quantity limits currently require ‘All rules’ so checkout enforcement can match storefront evaluation.",
    });
  });
});
