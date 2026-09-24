import { describe, expect, it } from "vitest";
import {
  buildAttributeQueryVariables,
  MAX_CUSTOM_CART_ATTRIBUTE_KEYS,
  MAX_CUSTOM_LINE_ATTRIBUTE_KEYS,
} from "./attribute-query-variables.js";

describe("buildAttributeQueryVariables", () => {
  it("allocates deterministic Function input slots independently for each store config", () => {
    const firstStore = buildAttributeQueryVariables([
      { conditionType: "line_attribute", value: { key: "engraving_message" } },
      { conditionType: "cart_attribute", value: { key: "affiliate_campaign" } },
      { conditionType: "line_attribute", value: { key: "__landing_source" } },
    ]);
    const secondStore = buildAttributeQueryVariables([
      { conditionType: "line_attribute", value: { key: "custom_bundle" } },
    ]);

    expect(firstStore).toEqual({ l1: "engraving_message", c1: "affiliate_campaign" });
    expect(secondStore).toEqual({ l1: "custom_bundle" });
  });

  it("uses metadata for additional line keys and fails visibly for unsupported cart keys", () => {
    const lineConditions = Array.from({ length: MAX_CUSTOM_LINE_ATTRIBUTE_KEYS + 1 }, (_, index) => ({
      conditionType: "line_attribute",
      value: { key: `line_${index}` },
    }));
    const cartConditions = Array.from({ length: MAX_CUSTOM_CART_ATTRIBUTE_KEYS + 1 }, (_, index) => ({
      conditionType: "cart_attribute",
      value: { key: `cart_${index}` },
    }));

    expect(buildAttributeQueryVariables(lineConditions)).toEqual({ l1: "line_0", l2: "line_1" });
    expect(() => buildAttributeQueryVariables(cartConditions)).toThrow("custom cart attribute keys");
  });
});
