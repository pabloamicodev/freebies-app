/**
 * Client-safe half of the theme catalog: types and the pure ref helpers the
 * picker and the server share. `theme-catalog.server.ts` re-exports these.
 */

export interface ThemeTemplate {
  ref: string;
  pageType: string;
  file: string;
}

export interface ThemeSection {
  /** `template/key`, the stored value. */
  ref: string;
  template: string;
  key: string;
  type: string;
  /** "Section name (template)". */
  label: string;
  disabled: boolean;
}

export type ThemeCatalog =
  | { unavailable?: false; themeId: string; themeName: string; templates: ThemeTemplate[]; sections: ThemeSection[] }
  | { unavailable: true };

/** Stored refs (templates or `template/key` sections) that no longer exist in the theme. */
export function findStaleRefs(refs: string[], catalog: ThemeCatalog): string[] {
  if (catalog.unavailable) return [];
  const known = new Set([...catalog.templates.map((t) => t.ref), ...catalog.sections.map((s) => s.ref)]);
  return refs.filter((r) => !known.has(r));
}

/**
 * Pasted DOM id (`shopify-section-template--123__hero_abc`) or `template/key` ->
 * `template/key`. Null unless it resolves to exactly one section (D1).
 */
export function normalizeSectionRef(input: string, catalog: ThemeCatalog, templateHint?: string): string | null {
  if (catalog.unavailable) return null;
  const v = input.trim().replace(/^#/, "").replace(/^shopify-section-/, "");
  if (catalog.sections.some((s) => s.ref === v)) return v;
  const m = /^template--\d+__(.+)$/.exec(v);
  if (!m) return null;
  const matches = catalog.sections.filter((s) => s.key === m[1]);
  const scoped = templateHint ? matches.filter((s) => s.template === templateHint) : matches;
  return scoped.length === 1 ? scoped[0]!.ref : null;
}

/** `template/key` -> parts. The template ref may itself contain a slash (`customers/account`); the key never does. */
export function splitSectionRef(ref: string): { template: string; key: string } | null {
  const i = ref.lastIndexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { template: ref.slice(0, i), key: ref.slice(i + 1) };
}

/** Manual entry without a catalog: `template/key` only, because a DOM id carries no template name. */
export function parseManualSectionRef(input: string): { template: string; key: string } | null {
  const v = input.trim().replace(/^#/, "").replace(/^shopify-section-/, "");
  if (/^template--\d+__/.test(v)) return null;
  const parts = splitSectionRef(v);
  return parts && /^[A-Za-z0-9_-]{1,100}$/.test(parts.key)
    ? { template: parts.template.toLowerCase(), key: parts.key }
    : null;
}
