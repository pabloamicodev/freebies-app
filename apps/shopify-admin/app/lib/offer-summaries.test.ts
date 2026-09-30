import { describe, expect, it } from "vitest";
import { collectGids, conditionSummary, rewardHeadline, urlsFromCondition } from "./offer-summaries.js";

describe("collectGids", () => {
  it("collects variant and product GIDs from every target shape", () => {
    expect(collectGids({ variantIds: ["v1", "v2"] })).toEqual(["v1", "v2"]);
    expect(collectGids({ productIds: ["p1"] })).toEqual(["p1"]);
    expect(collectGids({ variantId: "v1" })).toEqual(["v1"]);
    expect(collectGids({ productId: "p1" })).toEqual(["p1"]);
    expect(collectGids({ productId: "p1", variantIds: ["v1"] })).toEqual(["v1", "p1"]);
  });

  it("returns an empty array for scope-only or malformed targets", () => {
    expect(collectGids({ scope: "cart" })).toEqual([]);
    expect(collectGids(null)).toEqual([]);
    expect(collectGids("not an object")).toEqual([]);
    expect(collectGids({ variantIds: [1, null, "v1"] })).toEqual(["v1"]);
  });
});

describe("urlsFromCondition", () => {
  it("extracts page_url patterns", () => {
    expect(urlsFromCondition("page_url", { patterns: ["/pages/vip", "/collections/sale"] })).toEqual([
      "/pages/vip",
      "/collections/sale",
    ]);
  });

  it("extracts a specific_link requiredUrl", () => {
    expect(urlsFromCondition("specific_link", { requiredUrl: "/pages/vip" })).toEqual(["/pages/vip"]);
  });

  it("returns an empty array for a specific_link with no requiredUrl set", () => {
    expect(urlsFromCondition("specific_link", { requiredUrl: "" })).toEqual([]);
    expect(urlsFromCondition("specific_link", {})).toEqual([]);
  });

  it("returns an empty array for condition types with no URL", () => {
    expect(urlsFromCondition("cart_value", { thresholdCents: 5000 })).toEqual([]);
    expect(urlsFromCondition("discount_code", { code: "PRIME2026" })).toEqual([]);
  });
});

describe("conditionSummary", () => {
  it("renders only the UTM fields that are set, using real query-string keys", () => {
    expect(conditionSummary("utm_parameters", { utmSource: "amazon", utmCampaign: "primeday" })).toBe(
      "utm_source=amazon, utm_campaign=primeday",
    );
  });

  it("falls back to a no-parameters message when utm_parameters has nothing set", () => {
    expect(conditionSummary("utm_parameters", {})).toBe("no UTM parameters set");
  });
});

describe("rewardHeadline", () => {
  it("labels free rewards by reward type", () => {
    expect(rewardHeadline({ rewardType: "product_gift", discountType: "free", value: {} })).toBe("Free gift");
    expect(rewardHeadline({ rewardType: "shipping_discount", discountType: "free", value: {} })).toBe("Free shipping");
    expect(rewardHeadline({ rewardType: "order_discount", discountType: "free", value: {} })).toBe("Free (100% off)");
  });

  it("formats percentage and cheapest/most-expensive-item rewards", () => {
    expect(rewardHeadline({ rewardType: "order_discount", discountType: "percentage", value: { amount: 20 } })).toBe("20% off");
    expect(rewardHeadline({ rewardType: "order_discount", discountType: "cheapest_item_free", value: {} })).toBe("Cheapest item free");
    expect(
      rewardHeadline({ rewardType: "product_discount", discountType: "most_expensive_item_discount", value: { amount: 50 } }),
    ).toBe("50% off most expensive item");
  });

  it("converts fixed_amount/fixed_price from cents for ordinary rewards", () => {
    expect(
      rewardHeadline({ rewardType: "order_discount", discountType: "fixed_amount", value: { amount: 1000, currencyCode: "USD" } }),
    ).toBe("USD 10.00 off");
    expect(
      rewardHeadline({ rewardType: "product_discount", discountType: "fixed_price", value: { amount: 500, currencyCode: "USD" } }),
    ).toBe("Fixed price USD 5.00");
  });

  it("treats shipping_discount fixed_amount as already-dollar, not cents", () => {
    expect(
      rewardHeadline({ rewardType: "shipping_discount", discountType: "fixed_amount", value: { amount: 10, currencyCode: "USD" } }),
    ).toBe("USD 10.00 off");
  });
});
