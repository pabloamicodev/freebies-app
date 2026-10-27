import { describe, expect, it } from "vitest";
import { ConditionTypeSchema, validateConditionValue } from "@promo/shared-types";
import { MAIN_CONDITION_OPTIONS, VALUE_FIRST_CONDITIONS, valueFirstType } from "./main-condition-options.js";

describe("Add condition dropdown", () => {
  it("offers template, section shown and test group", () => {
    const values = MAIN_CONDITION_OPTIONS.map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["template", "section_shown", "experiment"]));
  });

  it("only lists real condition types", () => {
    for (const o of MAIN_CONDITION_OPTIONS) expect(ConditionTypeSchema.safeParse(o.value).success).toBe(true);
  });

  it("picks the value of these conditions before inserting, since the empty value is invalid on an active offer", () => {
    for (const type of VALUE_FIRST_CONDITIONS) {
      expect(valueFirstType(type)).toBe(type);
      expect(validateConditionValue(type, {}).success).toBe(false);
    }
    expect(validateConditionValue("template", { templates: ["page.landing"] }).success).toBe(true);
    expect(validateConditionValue("experiment", { experimentId: "abcd1234", variantKeys: ["control"] }).success).toBe(true);
    expect(valueFirstType("cart_value")).toBeNull();
  });
});
