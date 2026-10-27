import { describe, expect, it } from "vitest";
import {
  CONDITION_REGISTRY,
  CONDITION_VALUE_SCHEMAS,
  FUNCTION_ENFORCED_CONDITION_TYPES,
  PAGE_CONDITION_TYPES,
  STAMP_CAPS,
  capStampEntries,
  collectStampTargets,
  isPageConditionType,
  validateConditionValue,
} from "./index.js";

describe("PAGE_CONDITION_TYPES (single source)", () => {
  it("lists the 7 page conditions and every one is Function-enforced with a schema", () => {
    expect([...PAGE_CONDITION_TYPES]).toEqual([
      "page_url",
      "specific_link",
      "utm_parameters",
      "page_types",
      "template",
      "section_shown",
      "experiment",
    ]);
    for (const type of PAGE_CONDITION_TYPES) {
      expect(CONDITION_REGISTRY[type].enforcedByFunction).toBe(true);
      expect(FUNCTION_ENFORCED_CONDITION_TYPES.has(type)).toBe(true);
      expect(CONDITION_VALUE_SCHEMAS[type]).toBeDefined();
    }
    expect(isPageConditionType("template")).toBe(true);
    expect(isPageConditionType("cart_value")).toBe(false);
  });
});

describe("template condition schema", () => {
  it("accepts refs, lowercases them and takes the flags", () => {
    const parsed = validateConditionValue("template", {
      templates: ["Page.Landing-Nektar", "customers/account", "product"],
      scope: "page",
      onlyMatchedLines: true,
      rejectUnmatchedLines: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { templates: string[] }).templates[0]).toBe("page.landing-nektar");
  });
  it("rejects empty, bad charset, over-long, too many and bad scope", () => {
    expect(validateConditionValue("template", { templates: [] }).success).toBe(false);
    expect(validateConditionValue("template", { templates: ["page landing"] }).success).toBe(false);
    expect(validateConditionValue("template", { templates: ["../x"] }).success).toBe(false);
    expect(validateConditionValue("template", { templates: ["a".repeat(101)] }).success).toBe(false);
    expect(validateConditionValue("template", { templates: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(validateConditionValue("template", { templates: ["product"], scope: "session" }).success).toBe(false);
  });
});

describe("section_shown condition schema", () => {
  const ok = { template: "page.landing-nektar", key: "hero_abc", label: "Hero" };
  it("accepts template/key pairs", () => {
    expect(validateConditionValue("section_shown", { sections: [ok], scope: "visit" }).success).toBe(true);
    expect(validateConditionValue("section_shown", { sections: [{ template: "p", key: "Hero_MLswap-v" }] }).success).toBe(true);
  });
  it("rejects empty, bad key, bad template and > 20", () => {
    expect(validateConditionValue("section_shown", { sections: [] }).success).toBe(false);
    expect(validateConditionValue("section_shown", { sections: [{ ...ok, key: "hero.abc" }] }).success).toBe(false);
    expect(validateConditionValue("section_shown", { sections: [{ ...ok, key: "" }] }).success).toBe(false);
    expect(validateConditionValue("section_shown", { sections: [{ ...ok, key: "k".repeat(101) }] }).success).toBe(false);
    expect(validateConditionValue("section_shown", { sections: [{ ...ok, template: "bad name" }] }).success).toBe(false);
    expect(validateConditionValue("section_shown", { sections: Array.from({ length: 21 }, () => ok) }).success).toBe(false);
  });
});

describe("experiment condition schema", () => {
  const ok = { experimentId: "clx9k2abcd", variantKeys: ["control", "variant_a"] };
  it("accepts an experiment with arms and label snapshots", () => {
    expect(
      validateConditionValue("experiment", {
        ...ok,
        experimentName: "PDP hero v2",
        variantLabels: { control: "Control" },
        scope: "page",
        onlyMatchedLines: true,
      }).success,
    ).toBe(true);
  });
  it("rejects bad id, bad arm, empty and > 10 arms", () => {
    expect(validateConditionValue("experiment", { ...ok, experimentId: "short" }).success).toBe(false);
    expect(validateConditionValue("experiment", { ...ok, experimentId: "CLX9K2ABCD" }).success).toBe(false);
    expect(validateConditionValue("experiment", { ...ok, experimentId: "a".repeat(41) }).success).toBe(false);
    expect(validateConditionValue("experiment", { ...ok, variantKeys: [] }).success).toBe(false);
    expect(validateConditionValue("experiment", { ...ok, variantKeys: ["a b"] }).success).toBe(false);
    expect(validateConditionValue("experiment", { ...ok, variantKeys: ["k".repeat(65)] }).success).toBe(false);
    expect(
      validateConditionValue("experiment", { ...ok, variantKeys: Array.from({ length: 11 }, (_, i) => `v${i}`) }).success,
    ).toBe(false);
    expect(validateConditionValue("experiment", { variantKeys: ["control"] }).success).toBe(false);
  });
});

describe("capStampEntries", () => {
  it("keeps order and drops the tail past the entry cap", () => {
    const entries = Array.from({ length: 12 }, (_, i) => `t/s${i}`);
    expect(capStampEntries(entries, STAMP_CAPS._promo_sections).split(",")).toEqual(entries.slice(0, 8));
    expect(capStampEntries(["a", "b", "c", "d", "e"], STAMP_CAPS._promo_template)).toBe("a,b,c,d");
    expect(capStampEntries(["a", "b", "c", "d", "e"], STAMP_CAPS._promo_exp)).toBe("a,b,c,d");
  });
  it("stops at the first entry that would exceed the char cap (commas counted)", () => {
    const long = "x".repeat(100);
    expect(capStampEntries([long, long, "y"], { maxEntries: 8, maxChars: 201 })).toBe(`${long},${long}`);
    expect(capStampEntries([long, long, "y"], { maxEntries: 8, maxChars: 200 })).toBe(long);
    expect(capStampEntries([long, "y"], { maxEntries: 8, maxChars: 50 })).toBe("");
  });
  it("skips empty entries and handles an empty list", () => {
    expect(capStampEntries(["", "a", ""], STAMP_CAPS._promo_sections)).toBe("a");
    expect(capStampEntries([], STAMP_CAPS._promo_sections)).toBe("");
  });
  it("a full-cap section stamp stays within 512 chars", () => {
    const entries = Array.from({ length: 8 }, () => "p".repeat(100));
    expect(capStampEntries(entries, STAMP_CAPS._promo_sections).length).toBeLessThanOrEqual(512);
  });
});

describe("collectStampTargets", () => {
  const c = (conditionType: string, value: unknown, isEnabled = true) => ({ conditionType, value, isEnabled });
  it("is empty for no conditions or conditions that need no stamp (the runtime then stamps nothing)", () => {
    expect(collectStampTargets([])).toEqual({ s: [], t: [] });
    expect(collectStampTargets([c("page_url", { patterns: ["/x"] }), c("template", { templates: ["product"] }, false)])).toEqual({ s: [], t: [] });
  });
  it("unions, lowercases templates, sorts, dedupes and omits e when unused", () => {
    expect(
      collectStampTargets([
        c("template", { templates: ["Product", "index", "product"] }),
        c("section_shown", { sections: [{ template: "Page.X", key: "Hero_1" }, { template: "page.x", key: "Hero_1" }, { template: "bad name", key: "k" }] }),
        c("experiment", { experimentId: "abcd1234", variantKeys: ["a"] }),
        c("experiment", { experimentId: "abcd1234", variantKeys: ["b"] }),
        c("experiment", { experimentId: "nope", variantKeys: ["b"] }),
      ]),
    ).toEqual({ s: ["page.x/Hero_1"], t: ["index", "product"], e: ["abcd1234"] });
  });
  it("caps s at 200, t at 100 and e at 50", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => String(i).padStart(4, "0"));
    const targets = collectStampTargets([
      c("template", { templates: many(150).map((i) => `t${i}`) }),
      c("section_shown", { sections: many(300).map((i) => ({ template: "index", key: `k${i}` })) }),
      ...many(60).map((i) => c("experiment", { experimentId: `abcd${i}`, variantKeys: ["a"] })),
    ]);
    expect([targets.s.length, targets.t.length, targets.e?.length]).toEqual([200, 100, 50]);
  });
});
