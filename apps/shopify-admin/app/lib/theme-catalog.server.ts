/**
 * Published-theme catalog for the template/section page conditions: templates
 * (`templates/*.json|liquid`) and the sections they use, read through the
 * Admin GraphQL `theme.files`. Header/footer groups and static sections are
 * out of stage 1.
 */

import { shopifyGraphQL } from "./shopify-fetch.server.js";
import { redisGetString, redisSetString } from "./redis.server.js";

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

export interface ThemeCatalogAuth {
  shopDomain: string;
  accessToken: string;
}

export const THEME_CATALOG_TTL_SECONDS = 600;
const SCHEMA_PAGE_SIZE = 25;
const FILENAMES_PER_QUERY = 100;
const MAX_PAGES = 20;

const THEME_HEAD_QUERY = `query PromoEngineThemeHead { themes(first: 1, roles: [MAIN]) { nodes { id name updatedAt } } }`;

const TEMPLATES_QUERY = `query PromoEngineThemeTemplates($after: String) {
  themes(first: 1, roles: [MAIN]) {
    nodes {
      id name updatedAt
      files(first: 100, after: $after, filenames: ["templates/*", "templates/customers/*", "locales/*.default.schema.json"]) {
        nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const SCHEMAS_QUERY = `query PromoEngineSectionSchemas($filenames: [String!]!, $after: String) {
  themes(first: 1, roles: [MAIN]) { nodes { id name files(first: ${SCHEMA_PAGE_SIZE}, after: $after, filenames: $filenames) {
    nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
    pageInfo { hasNextPage endCursor } } } }
}`;

interface FileNode {
  filename: string;
  body?: { content?: string } | null;
}
interface FilesConn {
  nodes: FileNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface HeadData {
  themes: { nodes: Array<{ id: string; name: string; updatedAt?: string }> };
}
interface FilesData {
  themes: { nodes: Array<{ id: string; name: string; files: FilesConn }> };
}

const PAGE_TYPES: Record<string, string> = {
  index: "Home page",
  page: "Page",
  product: "Product",
  collection: "Collection",
  "list-collections": "Collections list",
  blog: "Blog",
  article: "Article",
  cart: "Cart",
  search: "Search",
  "404": "Not found",
  password: "Password",
  gift_card: "Gift card",
  metaobject: "Metaobject",
};

export function pageTypeLabel(ref: string): string {
  if (ref.startsWith("customers/")) return `Customer account (${ref.slice("customers/".length)})`;
  return PAGE_TYPES[ref.split(".")[0]!] ?? "Template";
}

/** `templates/page.x.json` -> `page.x`; `templates/customers/account.json` -> `customers/account`. */
export function templateRefFromFilename(filename: string): string | null {
  const m = /^templates\/(.+)\.(json|liquid)$/.exec(filename);
  return m ? m[1]! : null;
}

export function parseThemeJson(raw: string): unknown {
  const stripped = raw.replace(/^﻿/, "").replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function resolveLocale(name: string, locale: unknown): string {
  if (!name.startsWith("t:")) return name;
  let node: unknown = locale;
  for (const part of name.slice(2).split(".")) {
    if (node && typeof node === "object") node = (node as Record<string, unknown>)[part];
    else return "";
  }
  return typeof node === "string" ? node : "";
}

/** Section display name from the `{% schema %}` of a section file; "" when unknown. */
export function schemaName(liquid: string, locale: unknown): string {
  const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(liquid);
  if (!m) return "";
  try {
    const name = (JSON.parse(m[1]!) as { name?: unknown }).name;
    return typeof name === "string" ? resolveLocale(name, locale).trim() : "";
  } catch {
    return "";
  }
}

export interface RawSection {
  template: string;
  key: string;
  type: string;
  custom: string;
  disabled: boolean;
}

export function extractSections(template: string, json: unknown): RawSection[] {
  if (!json || typeof json !== "object") return [];
  const sections = (json as { sections?: unknown }).sections;
  if (!sections || typeof sections !== "object") return [];
  const order = (json as { order?: unknown }).order;
  const keys = Object.keys(sections as object);
  const ordered = Array.isArray(order)
    ? [...order.filter((k): k is string => typeof k === "string" && keys.includes(k)), ...keys.filter((k) => !order.includes(k))]
    : keys;
  return ordered.map((key) => {
    const s = (sections as Record<string, { type?: unknown; name?: unknown; disabled?: unknown }>)[key] ?? {};
    return {
      template,
      key,
      type: typeof s.type === "string" ? s.type : "",
      custom: typeof s.name === "string" ? s.name.trim() : "",
      disabled: s.disabled === true,
    };
  });
}

export function buildSection(raw: RawSection, schemaNames: Map<string, string>): ThemeSection {
  const name = raw.custom || schemaNames.get(raw.type) || raw.type || raw.key;
  return {
    ref: `${raw.template}/${raw.key}`,
    template: raw.template,
    key: raw.key,
    type: raw.type,
    label: `${name} (${raw.template})`,
    disabled: raw.disabled,
  };
}

async function fetchAllFiles(
  auth: ThemeCatalogAuth,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ files: FileNode[]; themeId: string; themeName: string }> {
  const files: FileNode[] = [];
  let after: string | null = null;
  let themeId = "";
  let themeName = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: FilesData = await shopifyGraphQL<FilesData>({ ...auth, query, variables: { ...variables, after } });
    const theme = data.themes.nodes[0];
    if (!theme) break;
    themeId = theme.id;
    themeName = theme.name;
    files.push(...theme.files.nodes);
    if (!theme.files.pageInfo.hasNextPage) break;
    after = theme.files.pageInfo.endCursor;
  }
  return { files, themeId, themeName };
}

const text = (f: FileNode) => f.body?.content ?? "";

export async function buildThemeCatalog(auth: ThemeCatalogAuth): Promise<ThemeCatalog> {
  const q1 = await fetchAllFiles(auth, TEMPLATES_QUERY, {});
  if (!q1.themeId) return { unavailable: true };

  let locale: unknown = null;
  const templates: ThemeTemplate[] = [];
  const raws: RawSection[] = [];
  for (const f of q1.files) {
    if (/^locales\/[^/]+\.default\.schema\.json$/.test(f.filename)) {
      locale = parseThemeJson(text(f));
      continue;
    }
    const ref = templateRefFromFilename(f.filename);
    if (!ref) continue;
    templates.push({ ref, pageType: pageTypeLabel(ref), file: f.filename });
    if (f.filename.endsWith(".json")) raws.push(...extractSections(ref, parseThemeJson(text(f))));
  }
  templates.sort((a, b) => a.ref.localeCompare(b.ref));

  const types = [...new Set(raws.map((r) => r.type).filter(Boolean))];
  const schemaNames = new Map<string, string>();
  for (let i = 0; i < types.length; i += FILENAMES_PER_QUERY) {
    const chunk = types.slice(i, i + FILENAMES_PER_QUERY);
    try {
      const { files } = await fetchAllFiles(auth, SCHEMAS_QUERY, { filenames: chunk.map((t) => `sections/${t}.liquid`) });
      for (const f of files) {
        const type = /^sections\/(.+)\.liquid$/.exec(f.filename)?.[1];
        if (!type) continue;
        const name = schemaName(text(f), locale);
        if (name) schemaNames.set(type, name);
      }
    } catch {
      // names fall back to the section type
    }
  }

  return {
    themeId: q1.themeId,
    themeName: q1.themeName,
    templates,
    sections: raws.map((r) => buildSection(r, schemaNames)),
  };
}

export const themeCatalogCacheKey = (shopDomain: string, themeId: string, updatedAt = "") =>
  `theme-catalog:${shopDomain}:${themeId}:${updatedAt}`;

/** Cached for 10 minutes per shop + published theme version; Redis trouble only skips the cache. */
export async function getThemeCatalog(auth: ThemeCatalogAuth): Promise<ThemeCatalog> {
  try {
    const head = await shopifyGraphQL<HeadData>({ ...auth, query: THEME_HEAD_QUERY, variables: {} });
    const theme = head.themes.nodes[0];
    if (!theme) return { unavailable: true };
    const key = themeCatalogCacheKey(auth.shopDomain, theme.id, theme.updatedAt);
    try {
      const hit = await redisGetString(key);
      if (hit) return JSON.parse(hit) as ThemeCatalog;
    } catch {
      // treated as a miss
    }
    const catalog = await buildThemeCatalog(auth);
    if (!catalog.unavailable) {
      try {
        await redisSetString(key, JSON.stringify(catalog), THEME_CATALOG_TTL_SECONDS);
      } catch {
        // uncached
      }
    }
    return catalog;
  } catch {
    return { unavailable: true };
  }
}

/** Stored refs (templates or `template/key` sections) that no longer exist in the theme. */
export function findStaleRefs(refs: string[], catalog: ThemeCatalog): string[] {
  if (catalog.unavailable) return [];
  const known = new Set([...catalog.templates.map((t) => t.ref), ...catalog.sections.map((s) => s.ref)]);
  return refs.filter((r) => !known.has(r));
}

export async function getStaleThemeRefs(auth: ThemeCatalogAuth, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  return findStaleRefs(refs, await getThemeCatalog(auth));
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
