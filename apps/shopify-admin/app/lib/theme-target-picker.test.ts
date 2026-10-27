import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeTargetPickerView, type CatalogState } from "../components/ThemeTargetPicker.js";
import { STALE_SECTION_MESSAGE, STALE_TEMPLATE_MESSAGE, type SectionSelection } from "./theme-target-selection.js";

const catalog: CatalogState = {
  themeId: "1",
  themeName: "Dawn",
  templates: [{ ref: "page.landing-nektar", pageType: "Page", file: "templates/page.landing-nektar.json" }],
  sections: [
    { ref: "page.landing-nektar/hero_abc", template: "page.landing-nektar", key: "hero_abc", type: "hero", label: "Hero con promo (page.landing-nektar)", disabled: false },
    { ref: "page.landing-nektar/old", template: "page.landing-nektar", key: "old", type: "hero", label: "Old (page.landing-nektar)", disabled: true },
  ],
};

const noop = () => undefined;
const sections = (value: SectionSelection[], state: CatalogState) =>
  renderToStaticMarkup(createElement(ThemeTargetPickerView, { kind: "section", idPrefix: "t", catalog: state, value, onChange: noop }));
const templates = (value: string[], state: CatalogState) =>
  renderToStaticMarkup(createElement(ThemeTargetPickerView, { kind: "template", idPrefix: "t", catalog: state, value, onChange: noop }));

describe("ThemeTargetPicker", () => {
  it("lists sections as 'Section name (template name)' with the key muted beside it", () => {
    const html = sections([], catalog);
    expect(html).toContain("Hero con promo (page.landing-nektar)");
    expect(html).toContain("hero_abc");
    expect(html).toContain("Old (page.landing-nektar) (disabled)");
  });

  it("lists templates with their page type", () => {
    const html = templates([], catalog);
    expect(html).toContain("page.landing-nektar");
    expect(html).toContain("Page");
  });

  it("checks the options that are already selected", () => {
    const html = sections([{ template: "page.landing-nektar", key: "hero_abc" }], catalog);
    expect(html).toMatch(/checked=""/);
    expect(html).not.toContain(STALE_SECTION_MESSAGE);
  });

  it("marks a section missing from the theme and shows the reselect warning", () => {
    const html = sections([{ template: "page.landing-nektar", key: "gone", label: "Gone (page.landing-nektar)" }], catalog);
    expect(html).toContain("not in published theme");
    expect(html.replace(/&#x27;/g, "'")).toContain(STALE_SECTION_MESSAGE);
  });

  it("warns about a stale template", () => {
    const html = templates(["page.gone"], catalog);
    expect(html).toContain("not in published theme");
    expect(html).toContain(STALE_TEMPLATE_MESSAGE);
  });

  it("falls back to manual entry and the stored label when the theme is unreadable", () => {
    for (const state of [{ unavailable: true } as CatalogState, null]) {
      const html = sections([{ template: "page.landing-nektar", key: "hero_abc", label: "Hero con promo (page.landing-nektar)" }], state);
      expect(html).toContain("could not be read");
      expect(html).toContain("Hero con promo (page.landing-nektar)");
      expect(html).toContain("Add a section by ID");
      expect(html).not.toContain("not in published theme");
      expect(html).not.toContain("Search sections");
    }
  });

  it("shows a loading hint and the manual field while the catalog loads", () => {
    const html = sections([], undefined);
    expect(html).toContain("Loading your published theme");
    expect(html).toContain("Add a section by ID");
  });
});
