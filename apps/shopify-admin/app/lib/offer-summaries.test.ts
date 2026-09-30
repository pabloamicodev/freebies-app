import { describe, expect, it } from "vitest";
import { collectGids, urlsFromCondition } from "./offer-summaries.js";

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
