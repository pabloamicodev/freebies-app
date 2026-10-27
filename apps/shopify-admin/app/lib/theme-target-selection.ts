/** Pure state helpers behind ThemeTargetPicker (template / section_shown selections). */

import { TemplateRefSchema } from "@promo/shared-types";
import {
  findStaleRefs,
  normalizeSectionRef,
  parseManualSectionRef,
  type ThemeCatalog,
} from "./theme-refs.js";

export interface SectionSelection {
  template: string;
  key: string;
  /** Snapshot shown when the theme is unreadable. */
  label?: string;
}

export type ManualResult<T> = { ok: true; value: T[] } | { ok: false; error: string };

export const STALE_SECTION_MESSAGE =
  "This section is no longer in your published theme (a section that is deleted and re-added gets a new ID). Reselect it.";
export const STALE_TEMPLATE_MESSAGE = "This template is no longer in your published theme. Reselect it.";

/** Comparison only: display stays as written. */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export const sectionRefOf = (s: SectionSelection) => `${s.template}/${s.key}`;

export function readTemplates(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function readSections(value: unknown): SectionSelection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SectionSelection[] => {
    if (!entry || typeof entry !== "object") return [];
    const { template, key, label } = entry as Record<string, unknown>;
    if (typeof template !== "string" || typeof key !== "string") return [];
    return [{ template, key, ...(typeof label === "string" && label ? { label } : {}) }];
  });
}

export function toggleTemplate(selected: string[], ref: string): string[] {
  return selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref];
}

export function toggleSection(selected: SectionSelection[], section: SectionSelection): SectionSelection[] {
  const ref = sectionRefOf(section);
  return selected.some((s) => sectionRefOf(s) === ref)
    ? selected.filter((s) => sectionRefOf(s) !== ref)
    : [...selected, section];
}

/** Accepts `page.landing`, `templates/page.landing.json`, `Page.Landing`. */
export function addManualTemplate(selected: string[], input: string): ManualResult<string> {
  const cleaned = input.trim().replace(/^templates\//i, "").replace(/\.(json|liquid)$/i, "");
  if (!cleaned) return { ok: false, error: "Enter a template name." };
  const parsed = TemplateRefSchema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, error: "Invalid template name." };
  return { ok: true, value: selected.includes(parsed.data) ? selected : [...selected, parsed.data] };
}

/**
 * Manual section entry. With a catalog, `template/key` and pasted DOM ids
 * (`shopify-section-template--123__key`) resolve against it; without one only
 * `template/key` is accepted because a DOM id carries no template name.
 */
export function addManualSection(
  selected: SectionSelection[],
  input: string,
  catalog: ThemeCatalog | null,
  templateHint?: string,
): ManualResult<SectionSelection> {
  if (!input.trim()) return { ok: false, error: "Enter a section." };
  let next: SectionSelection | null = null;
  if (catalog && !catalog.unavailable) {
    const ref = normalizeSectionRef(input, catalog, templateHint);
    const found = ref ? catalog.sections.find((s) => s.ref === ref) : undefined;
    if (found) next = { template: found.template, key: found.key, label: found.label };
    else if (/template--\d+__/.test(input)) {
      return {
        ok: false,
        error: templateHint
          ? "No section with that ID in the selected template."
          : "That ID matches no section, or several. Pick the section from the list or type template/section-key.",
      };
    }
  }
  if (!next) {
    const parsed = parseManualSectionRef(input);
    if (!parsed) {
      return {
        ok: false,
        error: /template--\d+__/.test(input)
          ? "The theme list is unavailable, so a pasted ID cannot be resolved. Type template/section-key instead."
          : "Use the format template/section-key, e.g. page.landing/hero_abc.",
      };
    }
    next = parsed;
  }
  const ref = sectionRefOf(next);
  return { ok: true, value: selected.some((s) => sectionRefOf(s) === ref) ? selected : [...selected, next] };
}

/** Stored refs missing from the published theme. Empty when the theme is unreadable. */
export function staleTemplateRefs(selected: string[], catalog: ThemeCatalog | null): string[] {
  return catalog ? findStaleRefs(selected, catalog) : [];
}

export function staleSectionRefs(selected: SectionSelection[], catalog: ThemeCatalog | null): string[] {
  return catalog ? findStaleRefs(selected.map(sectionRefOf), catalog) : [];
}

/** "Section name (template name)" from the live catalog, else the stored snapshot, else the ref. */
export function sectionDisplayLabel(selection: SectionSelection, catalog: ThemeCatalog | null): string {
  if (catalog && !catalog.unavailable) {
    const live = catalog.sections.find((s) => s.ref === sectionRefOf(selection));
    if (live) return live.label;
  }
  return selection.label ?? sectionRefOf(selection);
}
