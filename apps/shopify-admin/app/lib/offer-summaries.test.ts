import { describe, expect, it } from "vitest";
import { ConditionTypeSchema, RewardTypeSchema } from "@promo/shared-types";
import { codesSummary, collectGids, conditionSummary, conditionTypeLabel, rewardHeadline, rewardSummary, rewardTypeLabel, urlsFromCondition } from "./offer-summaries.js";

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

  it("describes visit-scoped UTMs, page types and the reject-other-pages flag in plain words", () => {
    expect(conditionSummary("utm_parameters", { utmSource: "news", scope: "visit", rejectUnmatchedLines: true })).toBe(
      "utm_source=news (this visit) · other pages block it",
    );
    expect(conditionSummary("page_types", { pageTypes: ["home", "product"] })).toBe("added from Home page, Product pages");
    expect(conditionSummary("page_types", { pageTypes: [] })).toBe("no page types set");
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

describe("conditionSummary product wording", () => {
  it("says variants (all) for exact-variant requirements and products (any variant) for product mode", () => {
    expect(conditionSummary("specific_product", {
      requirements: Array.from({ length: 13 }, (_, i) => ({ variantId: `v${i}`, trackMode: "variant", minQuantity: 1 })),
    })).toBe("13 variants required (all)");
    expect(conditionSummary("pack_of_products", {
      requirements: [{ variantId: "v1", trackMode: "variant", quantityPerPack: 1 }],
    })).toBe("1 variant required (all)");
    expect(conditionSummary("specific_product", {
      requirements: [
        { productId: "p1", trackMode: "product", minQuantity: 1 },
        { productId: "p2", trackMode: "product", minQuantity: 1 },
      ],
    })).toBe("2 products required (any variant)");
  });
});

describe("conditionTypeLabel / rewardTypeLabel", () => {
  it("labels every condition type", () => {
    for (const type of ConditionTypeSchema.options) {
      const label = conditionTypeLabel(type);
      expect(label).not.toBe(type);
      expect(label).not.toContain("_");
    }
    expect(conditionTypeLabel("pack_of_products")).toBe("Pack of products");
    expect(conditionTypeLabel("something_new")).toBe("Something new");
  });

  it("labels every reward type and renders human reward text", () => {
    for (const type of RewardTypeSchema.options) expect(rewardTypeLabel(type)).not.toContain("_");
    expect(rewardSummary({ rewardType: "product_discount", discountType: "percentage", value: { amount: 20 } })).toBe("Product discount — 20% off");
    expect(rewardSummary({ rewardType: "product_gift", discountType: "free", value: {} })).toBe("Free gift");
    expect(rewardSummary({ rewardType: "shipping_discount", discountType: "free", value: {} })).toBe("Free shipping");
  });
});

describe("codesSummary", () => {
  const base = { total: 0, active: 0, samples: [], requiresCode: false, inert: false };

  it("covers no-code, code-required-without-codes and legacy cases", () => {
    expect(codesSummary(base).lines).toEqual(["No code needed — applies automatically"]);
    const required = codesSummary({ ...base, requiresCode: true, inert: true });
    expect(required.lines).toEqual(["Code required — no codes yet"]);
    expect(required.warning).toBeTruthy();
    expect(codesSummary({ ...base, requiresCode: true, legacyCode: "SAVE10" }).lines).toEqual(["Required code: SAVE10"]);
  });

  it("shows count, active and up to 3 samples, and an inert warning", () => {
    const summary = codesSummary({ total: 5, active: 4, samples: ["A", "B", "C"], requiresCode: true, inert: false });
    expect(summary.lines).toEqual(["5 codes · 4 active", "A, B, C, …"]);
    expect(summary.warning).toBeNull();
    expect(codesSummary({ total: 1, active: 0, samples: ["A"], requiresCode: true, inert: true })).toEqual({
      lines: ["1 code · 0 active", "A"],
      warning: expect.stringContaining("not live"),
    });
  });
});
