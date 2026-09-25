import { describe, expect, it } from "vitest";
import { normalizeGiftSubconditions, normalizeOfferSubconditions } from "./gift-subconditions.js";

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
      custom_attribute: {
        scope: "line",
        key: "engraving_message",
        value: "VIP",
        matchMode: "equals",
        minMatchingQuantity: 2,
      },
      quantity_limit: {
        matchMode: "all",
        rules: [
          {
            qty: 2,
            scope: "specific_products",
            operator: "at_least",
            productIds: ["gid://shopify/Product/1"],
          },
        ],
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
    expect(result.data[0]?.value).toEqual({
      requiredUrl: "/pages/vip",
      paramName: "code",
      paramValue: "summer",
    });
    expect(result.data[1]?.value).toMatchObject({ type: "total_orders", value: 3 });
    expect(result.data[5]?.value).toEqual({ channels: ["online_store", "pos"] });
    expect(result.data[7]?.value).toEqual({
      key: "engraving_message",
      value: "VIP",
      matchMode: "equals",
      minMatchingQuantity: 2,
    });
    expect(result.data[8]?.value).toEqual({
      requirements: [
        { productId: "gid://shopify/Product/1", trackMode: "product", minQuantity: 2 },
      ],
      multiplyByGroups: false,
    });
  });

  it("exposes the same canonical normalizer to every offer wizard", () => {
    const input = {
      link: { requiredUrl: "/pages/protein", paramName: "source", paramValue: "email" },
      subscription: { mode: "one_time_only" },
      custom_attribute: {
        scope: "line",
        key: "__landing_source",
        value: "protein-lp",
        matchMode: "equals",
        minMatchingQuantity: 3,
      },
    };

    expect(normalizeOfferSubconditions(input)).toEqual(normalizeGiftSubconditions(input));
    expect(normalizeOfferSubconditions(input)).toMatchObject({
      success: true,
      data: [
        { conditionType: "specific_link", operator: "eq" },
        { conditionType: "subscription_product_type", value: { mode: "one_time_only" } },
        {
          conditionType: "line_attribute",
          value: { key: "__landing_source", value: "protein-lp", minMatchingQuantity: 3 },
        },
      ],
    });
  });

  it("accepts the canonical records emitted by the current condition forms", () => {
    const result = normalizeOfferSubconditions({
      customer_tags: {
        includeTags: ["vip"],
        excludeTags: ["blocked"],
        treatGuestAsNoTags: false,
      },
      location: { includeCountryCodes: ["us"], excludeCountryCodes: ["ca"] },
      sales_channel: { channels: ["online_store", "pos"] },
      markets: {
        includeMarketIds: ["gid://shopify/Market/1"],
        excludeMarketIds: ["gid://shopify/Market/2"],
      },
    });

    expect(result).toEqual({
      success: true,
      data: [
        {
          conditionType: "customer_tags",
          operator: "eq",
          value: {
            includeTags: ["vip"],
            excludeTags: ["blocked"],
            treatGuestAsNoTags: false,
          },
        },
        {
          conditionType: "customer_location",
          operator: "eq",
          value: { includeCountryCodes: ["US"], excludeCountryCodes: ["CA"] },
        },
        {
          conditionType: "sales_channels",
          operator: "eq",
          value: { channels: ["online_store", "pos"] },
        },
        {
          conditionType: "markets",
          operator: "eq",
          value: {
            includeMarketIds: ["gid://shopify/Market/1"],
            excludeMarketIds: ["gid://shopify/Market/2"],
          },
        },
      ],
    });
  });

  it("fails visibly instead of persisting unsupported ambiguous quantity rules", () => {
    const result = normalizeGiftSubconditions({
      quantity_limit: {
        matchMode: "any",
        rules: [
          {
            qty: 2,
            scope: "specific_products",
            operator: "at_least",
            productIds: ["gid://shopify/Product/1"],
          },
        ],
      },
    });

    expect(result).toEqual({
      success: false,
      error:
        "Quantity limits currently require ‘All rules’ so checkout enforcement can match storefront evaluation.",
    });
  });
});
