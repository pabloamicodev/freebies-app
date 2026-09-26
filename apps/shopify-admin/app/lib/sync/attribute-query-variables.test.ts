import { describe, expect, it } from "vitest";
import { buildAttributeQueryVariables, MAX_CUSTOM_CART_ATTRIBUTE_KEYS } from "./attribute-query-variables.js";

describe("buildAttributeQueryVariables", () => {
  it("allocates cart attribute slots; line attributes travel in packed metadata", () => {
    const firstStore = buildAttributeQueryVariables([
      { conditionType: "line_attribute", value: { key: "engraving_message" } },
      { conditionType: "cart_attribute", value: { key: "affiliate_campaign" } },
      { conditionType: "line_attribute", value: { key: "__landing_source" } },
    ]);
    const secondStore = buildAttributeQueryVariables([
      { conditionType: "line_attribute", value: { key: "custom_bundle" } },
    ]);

    expect(firstStore).toEqual({ c1: "affiliate_campaign" });
    expect(secondStore).toEqual({});
  });

  it("fails visibly for unsupported cart keys", () => {
    const cartConditions = Array.from({ length: MAX_CUSTOM_CART_ATTRIBUTE_KEYS + 1 }, (_, index) => ({
      conditionType: "cart_attribute",
      value: { key: `cart_${index}` },
    }));
    expect(() => buildAttributeQueryVariables(cartConditions)).toThrow("custom cart attribute keys");
  });
});
