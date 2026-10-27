import { describe, expect, it } from "vitest";
import {
  addManualSection,
  addManualTemplate,
  normalizeForSearch,
  readSections,
  sectionDisplayLabel,
  staleSectionRefs,
  staleTemplateRefs,
  toggleSection,
  toggleTemplate,
} from "./theme-target-selection.js";
import { parseManualSectionRef, splitSectionRef, type ThemeCatalog } from "./theme-refs.js";

const catalog: ThemeCatalog = {
  themeId: "gid://shopify/OnlineStoreTheme/1",
  themeName: "Dawn",
  templates: [
    { ref: "page.landing-nektar", pageType: "Page", file: "templates/page.landing-nektar.json" },
    { ref: "product", pageType: "Product", file: "templates/product.json" },
  ],
  sections: [
    { ref: "page.landing-nektar/hero_abc", template: "page.landing-nektar", key: "hero_abc", type: "hero", label: "Hero con promo (page.landing-nektar)", disabled: false },
    { ref: "product/hero_abc", template: "product", key: "hero_abc", type: "hero", label: "Hero (product)", disabled: false },
    { ref: "product/main", template: "product", key: "main", type: "main-product", label: "Product (product)", disabled: false },
  ],
};
const unavailable: ThemeCatalog = { unavailable: true };

describe("selection toggles", () => {
  it("adds and removes templates and sections", () => {
    expect(toggleTemplate([], "product")).toEqual(["product"]);
    expect(toggleTemplate(["product"], "product")).toEqual([]);
    const section = { template: "product", key: "main", label: "Product (product)" };
    expect(toggleSection([], section)).toEqual([section]);
    expect(toggleSection([section], section)).toEqual([]);
  });
});

describe("manual template entry", () => {
  it("normalizes a file path, case and duplicates", () => {
    expect(addManualTemplate([], "templates/Page.Landing-Nektar.json")).toEqual({ ok: true, value: ["page.landing-nektar"] });
    expect(addManualTemplate(["product"], " product ")).toEqual({ ok: true, value: ["product"] });
  });

  it("rejects empty and malformed names", () => {
    expect(addManualTemplate([], " ").ok).toBe(false);
    expect(addManualTemplate([], "a b!").ok).toBe(false);
  });
});

describe("manual section entry with a catalog", () => {
  it("resolves a template/key ref and keeps the catalog label", () => {
    expect(addManualSection([], "page.landing-nektar/hero_abc", catalog)).toEqual({
      ok: true,
      value: [{ template: "page.landing-nektar", key: "hero_abc", label: "Hero con promo (page.landing-nektar)" }],
    });
  });

  it("normalizes a pasted DOM id when exactly one section matches", () => {
    const result = addManualSection([], "shopify-section-template--123__main", catalog);
    expect(result).toEqual({ ok: true, value: [{ template: "product", key: "main", label: "Product (product)" }] });
  });

  it("refuses an ambiguous DOM id unless a template hint disambiguates it", () => {
    const dom = "shopify-section-template--123__hero_abc";
    expect(addManualSection([], dom, catalog).ok).toBe(false);
    expect(addManualSection([], dom, catalog, "product")).toEqual({
      ok: true,
      value: [{ template: "product", key: "hero_abc", label: "Hero (product)" }],
    });
  });

  it("rejects a DOM id that matches nothing", () => {
    expect(addManualSection([], "template--9__nope", catalog).ok).toBe(false);
  });

  it("does not add the same section twice", () => {
    const once = addManualSection([], "product/main", catalog);
    if (!once.ok) throw new Error(once.error);
    expect(addManualSection(once.value, "product/main", catalog)).toEqual({ ok: true, value: once.value });
  });
});

describe("manual section entry when the theme is unreadable", () => {
  it("accepts template/key and lowercases the template", () => {
    expect(addManualSection([], "Page.Landing/hero_abc", unavailable)).toEqual({
      ok: true,
      value: [{ template: "page.landing", key: "hero_abc" }],
    });
    expect(addManualSection([], "customers/account/main", null)).toEqual({
      ok: true,
      value: [{ template: "customers/account", key: "main" }],
    });
  });

  it("cannot resolve a DOM id and says to type template/key", () => {
    const result = addManualSection([], "shopify-section-template--123__hero_abc", unavailable);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("template/section-key");
  });

  it("rejects a bare key", () => {
    expect(addManualSection([], "hero_abc", null).ok).toBe(false);
  });
});

describe("stale refs", () => {
  it("flags templates and sections missing from the published theme", () => {
    expect(staleTemplateRefs(["product", "page.gone"], catalog)).toEqual(["page.gone"]);
    expect(
      staleSectionRefs(
        [
          { template: "product", key: "main" },
          { template: "product", key: "deleted_readded" },
        ],
        catalog,
      ),
    ).toEqual(["product/deleted_readded"]);
  });

  it("reports nothing when the theme is unreadable or not loaded", () => {
    expect(staleTemplateRefs(["page.gone"], unavailable)).toEqual([]);
    expect(staleSectionRefs([{ template: "x", key: "y" }], null)).toEqual([]);
  });
});

describe("section labels", () => {
  it("prefers the live label, then the stored snapshot, then the ref", () => {
    const stored = { template: "product", key: "main", label: "Old name (product)" };
    expect(sectionDisplayLabel(stored, catalog)).toBe("Product (product)");
    expect(sectionDisplayLabel(stored, unavailable)).toBe("Old name (product)");
    expect(sectionDisplayLabel({ template: "product", key: "main" }, null)).toBe("product/main");
  });
});

describe("helpers", () => {
  it("normalizes search text for comparison only", () => {
    expect(normalizeForSearch("  Hero   ＣＯＮ  Promo ")).toBe("hero con promo");
  });

  it("reads stored sections defensively", () => {
    expect(readSections([{ template: "a", key: "b", label: "L" }, { template: 1 }, null])).toEqual([{ template: "a", key: "b", label: "L" }]);
    expect(readSections("nope")).toEqual([]);
  });

  it("splits refs on the last slash", () => {
    expect(splitSectionRef("customers/account/main")).toEqual({ template: "customers/account", key: "main" });
    expect(splitSectionRef("main")).toBeNull();
    expect(parseManualSectionRef("shopify-section-template--1__x")).toBeNull();
  });
});
