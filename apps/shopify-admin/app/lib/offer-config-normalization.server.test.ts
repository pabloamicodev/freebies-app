import { describe, expect, it } from "vitest";
import { normalizeConditionValue } from "./offer-config-normalization.server.js";

describe("normalizeConditionValue", () => {
  it("migrates legacy customer tag values without changing semantics", () => {
    expect(normalizeConditionValue("customer_tags", { tags: "vip, wholesale, vip", exclude: false, guest: true })).toEqual({
      includeTags: ["vip", "wholesale"],
      excludeTags: [],
      treatGuestAsNoTags: true,
    });
    expect(normalizeConditionValue("customer_tags", { tags: "blocked", exclude: true, guest: false })).toEqual({
      includeTags: [],
      excludeTags: ["blocked"],
      treatGuestAsNoTags: false,
    });
  });

  it("migrates country, market and sales-channel values", () => {
    expect(normalizeConditionValue("customer_location", { countries: "us, ca", exclude: true })).toEqual({
      includeCountryCodes: [],
      excludeCountryCodes: ["US", "CA"],
    });
    expect(normalizeConditionValue("markets", { marketIds: "gid://shopify/Market/1", exclude: false })).toEqual({
      includeMarketIds: ["gid://shopify/Market/1"],
      excludeMarketIds: [],
    });
    expect(normalizeConditionValue("sales_channels", { online: true, mobile: true, pos: false })).toEqual({
      channels: ["online_store", "mobile_app"],
    });
  });

  it("migrates subscription modes and preserves canonical values", () => {
    expect(normalizeConditionValue("subscription_product_type", { mode: "subscription" })).toEqual({ mode: "subscription_only" });
    const canonical = { includeTags: ["vip"], excludeTags: [], treatGuestAsNoTags: true };
    expect(normalizeConditionValue("customer_tags", canonical)).toBe(canonical);
  });

  it("migrates legacy product requirements", () => {
    expect(normalizeConditionValue("specific_product", {
      variantIds: ["gid://shopify/ProductVariant/1"],
      minQtyPerProduct: 2,
      multiplyGifts: true,
    })).toEqual({
      requirements: [{ variantId: "gid://shopify/ProductVariant/1", trackMode: "variant", minQuantity: 2 }],
      multiplyByGroups: true,
    });
  });

  it("fails closed for malformed stored JSON", () => {
    expect(normalizeConditionValue("customer_tags", null)).toEqual({
      includeTags: [],
      excludeTags: [],
      treatGuestAsNoTags: true,
    });
    expect(normalizeConditionValue("unknown", ["invalid"])).toEqual({});
  });
});
