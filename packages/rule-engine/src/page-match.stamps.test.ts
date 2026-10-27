import { describe, expect, it } from "vitest";
import type { NormalizedCartLine } from "@promo/shared-types";
import { evaluatePageConditionGroup, lineMatchesPageConditions } from "./page-match.js";
import { evaluateStampList } from "./conditions/page-context.js";

const PAGE = { _promo_page_url: "/pages/landing-nektar" };

const template = (templates: string[], extra: Record<string, unknown> = {}) => ({
  conditionType: "template",
  value: { templates, ...extra },
});
const section = (sections: Array<{ template: string; key: string }>, extra: Record<string, unknown> = {}) => ({
  conditionType: "section_shown",
  value: { sections, ...extra },
});
const experiment = (variantKeys: string[], extra: Record<string, unknown> = {}) => ({
  conditionType: "experiment",
  value: { experimentId: "clx9k2abcd", variantKeys, ...extra },
});

const line = (key: string, properties: Record<string, string>): NormalizedCartLine =>
  ({
    key,
    variantId: `v-${key}`,
    productId: `p-${key}`,
    quantity: 1,
    priceCents: 1000,
    compareAtPriceCents: null,
    properties,
  }) as NormalizedCartLine;

describe.each([
  {
    name: "template",
    stampKey: "_promo_template",
    make: template,
    a: ["page.landing-nektar"],
    both: ["page.landing-nektar", "product.acv-template"],
    stampA: "page.landing-nektar",
    stampB: "product.acv-template",
    other: "product",
  },
  {
    name: "section_shown",
    stampKey: "_promo_sections",
    make: (_: string[], extra?: Record<string, unknown>) =>
      section([{ template: "page.landing-nektar", key: "hero_abc" }], extra),
    a: [],
    both: [],
    stampA: "page.landing-nektar/hero_abc",
    stampB: "page.landing-nektar/hero_abc",
    other: "page.landing-nektar/footer_1",
  },
  {
    name: "experiment",
    stampKey: "_promo_exp",
    make: (_: string[], extra?: Record<string, unknown>) => experiment(["variant_a"], extra),
    a: [],
    both: [],
    stampA: "clx9k2abcd:variant_a",
    stampB: "clx9k2abcd:variant_a",
    other: "clx9k2abcd:control",
  },
])("$name matchMode", ({ stampKey, make, a, stampA, other }) => {
  const props = (stamp: string) => ({ ...PAGE, [stampKey]: stamp });

  it("matches a remembered entry (visit scope, the default)", () => {
    expect(lineMatchesPageConditions(props(stampA), [make(a)])).toBe(true);
  });

  it("matches a current-page @ entry", () => {
    expect(lineMatchesPageConditions(props(`@${stampA}`), [make(a)])).toBe(true);
  });

  it("is ASCII case-insensitive", () => {
    expect(lineMatchesPageConditions(props(stampA.toUpperCase()), [make(a)])).toBe(true);
  });

  it("matches when any entry in the list equals the ref", () => {
    expect(lineMatchesPageConditions(props(`${other},${stampA}`), [make(a)])).toBe(true);
    expect(lineMatchesPageConditions(props(`@${other},${stampA}`), [make(a)])).toBe(true);
  });

  it("rejects a non-selected ref", () => {
    expect(lineMatchesPageConditions(props(other), [make(a)])).toBe(false);
    expect(lineMatchesPageConditions(props(`@${other}`), [make(a)])).toBe(false);
  });

  it("scope 'page' counts only @ entries", () => {
    const cond = make(a, { scope: "page" });
    expect(lineMatchesPageConditions(props(stampA), [cond])).toBe(false);
    expect(lineMatchesPageConditions(props(`@${other},${stampA}`), [cond])).toBe(false);
    expect(lineMatchesPageConditions(props(`${other},@${stampA}`), [cond])).toBe(true);
  });

  it("scope 'visit' counts remembered and current entries", () => {
    const cond = make(a, { scope: "visit" });
    expect(lineMatchesPageConditions(props(stampA), [cond])).toBe(true);
    expect(lineMatchesPageConditions(props(`@${stampA}`), [cond])).toBe(true);
  });

  it("fails closed when the stamp is missing", () => {
    expect(lineMatchesPageConditions({ ...PAGE }, [make(a)])).toBe(false);
    expect(lineMatchesPageConditions({ ...PAGE }, [make(a, { scope: "page" })])).toBe(false);
  });

  it("fails closed without _promo_page_url even with a matching stamp", () => {
    expect(lineMatchesPageConditions({ [stampKey]: `@${stampA}` }, [make(a)])).toBe(false);
  });

  it.each(["", ",", ",,,", "@", "@,", " ", "@@" + "x", "no-match,,@"])("malformed stamp %j never matches and never throws", (raw) => {
    expect(lineMatchesPageConditions(props(raw), [make(a)])).toBe(false);
  });

  it("tolerates stray commas around a valid entry", () => {
    expect(lineMatchesPageConditions(props(`,,@${stampA},`), [make(a, { scope: "page" })])).toBe(true);
  });

  it("ANDs with a page_url condition on the same line", () => {
    const url = { conditionType: "page_url", value: { patterns: ["/pages/landing"], matchMode: "starts_with", caseSensitive: false } };
    expect(lineMatchesPageConditions(props(`@${stampA}`), [make(a), url])).toBe(true);
    expect(lineMatchesPageConditions({ ...props(`@${stampA}`), _promo_page_url: "/other" }, [make(a), url])).toBe(false);
  });
});

describe("template any-of", () => {
  const cond = template(["page.landing-nektar", "product.acv-template"]);
  it("matches whichever selected template is stamped", () => {
    expect(lineMatchesPageConditions({ ...PAGE, _promo_template: "product.acv-template" }, [cond])).toBe(true);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_template: "@page.landing-nektar" }, [cond])).toBe(true);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_template: "index" }, [cond])).toBe(false);
  });
});

describe("section any-of with ML-style keys", () => {
  const cond = section([
    { template: "product.acv-template", key: "hero_mlswap_v" },
    { template: "page.landing-nektar", key: "hero_abc" },
  ]);
  it("matches either section, keyed by template/key", () => {
    expect(lineMatchesPageConditions({ ...PAGE, _promo_sections: "@product.acv-template/hero_mlswap_v" }, [cond])).toBe(true);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_sections: "x/y,page.landing-nektar/hero_abc" }, [cond])).toBe(true);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_sections: "product.acv-template/hero" }, [cond])).toBe(false);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_sections: "hero_abc" }, [cond])).toBe(false);
  });
});

describe("experiment any-of arms", () => {
  const cond = experiment(["variant_a", "variant_b"]);
  it("matches any selected arm of the experiment, not another experiment", () => {
    expect(lineMatchesPageConditions({ ...PAGE, _promo_exp: "@clx9k2abcd:variant_b" }, [cond])).toBe(true);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_exp: "clx9k2abcd:control" }, [cond])).toBe(false);
    expect(lineMatchesPageConditions({ ...PAGE, _promo_exp: "zzzzzzzzzz:variant_a" }, [cond])).toBe(false);
  });
});

describe("two stamp conditions AND on the same line", () => {
  it("requires both", () => {
    const conds = [template(["page.landing-nektar"]), experiment(["variant_a"])];
    const both = { ...PAGE, _promo_template: "@page.landing-nektar", _promo_exp: "clx9k2abcd:variant_a" };
    expect(lineMatchesPageConditions(both, conds)).toBe(true);
    expect(lineMatchesPageConditions({ ...both, _promo_exp: "clx9k2abcd:control" }, conds)).toBe(false);
  });
});

describe("evaluatePageConditionGroup with stamp conditions", () => {
  const cond = template(["page.landing-nektar"], { rejectUnmatchedLines: true });
  it("passes when a line matches and none is unmatched", () => {
    const lines = [line("a", { ...PAGE, _promo_template: "@page.landing-nektar" })];
    expect(evaluatePageConditionGroup([cond], lines).passed).toBe(true);
  });
  it("reject mode fails on an unmatched line; an app-added upsell is exempt", () => {
    const matched = line("a", { ...PAGE, _promo_template: "@page.landing-nektar" });
    const unmatched = line("b", { ...PAGE, _promo_template: "index" });
    expect(evaluatePageConditionGroup([cond], [matched, unmatched]).passed).toBe(false);
    const upsell = line("c", { _promo_engine_line_type: "upsell" });
    expect(evaluatePageConditionGroup([cond], [matched, upsell]).passed).toBe(true);
  });
  it("fails closed with no stamp and reports the condition type", () => {
    const result = evaluatePageConditionGroup([cond], [line("a", { ...PAGE })]);
    expect(result.passed).toBe(false);
    expect(result.reasons[0]?.conditionType).toBe("template");
  });
});

describe("evaluateStampList", () => {
  it("reports the matched entry", () => {
    const r = evaluateStampList("section_shown", "@a/b,c/d", ["c/d"], false);
    expect(r.ok && r.value.actual).toBe("c/d");
  });
  it("does not match an empty ref against empty entries", () => {
    expect(evaluateStampList("template", ",", [""], false).ok).toBe(false);
  });
});

describe("packed page stamps", () => {
  const pageTypes = { conditionType: "page_types", value: { pageTypes: ["home", "product", "cart"] } };
  const packed = (stamp: Record<string, string>) => ({
    _page_origin: "index",
    _promo_engine_metadata: JSON.stringify({ _page_origin: "index", ...stamp }),
  });

  it("reads the stamp from _promo_engine_metadata when a form post packed it", () => {
    expect(lineMatchesPageConditions(packed({ _promo_page_url: "/cart" }), [pageTypes])).toBe(true);
    expect(evaluatePageConditionGroup([pageTypes], [line("a", packed({ _promo_page_url: "/cart" }))]).passed).toBe(true);
    expect(lineMatchesPageConditions(packed({ _promo_page_url: "/pages/landing" }), [pageTypes])).toBe(false);
  });

  it("prefers the top-level stamp and ignores unreadable metadata", () => {
    const both = { ...packed({ _promo_page_url: "/pages/landing" }), _promo_page_url: "/cart" };
    expect(lineMatchesPageConditions(both, [pageTypes])).toBe(true);
    expect(lineMatchesPageConditions({ _promo_engine_metadata: "{oops" }, [pageTypes])).toBe(false);
  });
});
