/**
 * Cart-line stamps for the template / section / experiment page conditions.
 * Each value is a comma-separated list of `[@]<ref>`: `@` marks a ref seen on the
 * page where the line was added, no prefix means remembered earlier in the visit.
 */
export const TEMPLATE_REF_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+)?(\.[a-z0-9_.-]+)?$/;
export const SECTION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const EXPERIMENT_ID_PATTERN = /^[a-z0-9]{8,40}$/;
export const VARIANT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const PROMO_TEMPLATE_KEY = "_promo_template";
export const PROMO_SECTIONS_KEY = "_promo_sections";
export const PROMO_EXPERIMENT_KEY = "_promo_exp";

export const PROMO_PAGE_URL_KEY = "_promo_page_url";
export const PROMO_LANDING_URL_KEY = "_promo_landing_url";

/** The keys a new cart line is stamped with: the only ones a request may send as its eligibility context. */
export const PROSPECTIVE_KEYS = [
  PROMO_PAGE_URL_KEY,
  PROMO_LANDING_URL_KEY,
  PROMO_TEMPLATE_KEY,
  PROMO_SECTIONS_KEY,
  PROMO_EXPERIMENT_KEY,
] as const;
export const PROSPECTIVE_MAX_CHARS = 2_048;

/**
 * Whitelists a client-sent eligibility context (`prospective` body field, decoded `ctx` query param):
 * only the stamp keys, string values, at most PROSPECTIVE_MAX_CHARS in total. Anything else yields `{}`,
 * which fails closed for page-conditioned offers.
 */
export function sanitizeProspective(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  let chars = 0;
  for (const key of PROSPECTIVE_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry !== "string" || entry === "") continue;
    chars += key.length + entry.length;
    if (chars > PROSPECTIVE_MAX_CHARS) return {};
    out[key] = entry;
  }
  return out;
}

export interface StampCap {
  maxEntries: number;
  maxChars: number;
}

export const STAMP_CAPS = {
  [PROMO_SECTIONS_KEY]: { maxEntries: 8, maxChars: 512 },
  [PROMO_TEMPLATE_KEY]: { maxEntries: 4, maxChars: 256 },
  [PROMO_EXPERIMENT_KEY]: { maxEntries: 4, maxChars: 256 },
} as const satisfies Record<string, StampCap>;

/** Joins entries in order, dropping the overflow from the tail once either cap would be exceeded. */
export function capStampEntries(entries: readonly string[], cap: StampCap): string {
  const kept: string[] = [];
  let chars = 0;
  for (const entry of entries) {
    if (entry === "") continue;
    const next = chars + entry.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= cap.maxEntries || next > cap.maxChars) break;
    kept.push(entry);
    chars = next;
  }
  return kept.join(",");
}

export interface StampTargets {
  s: string[];
  t: string[];
  e?: string[];
}

export const STAMP_TARGET_CAPS = { s: 200, t: 100, e: 50 } as const;

export const EMPTY_STAMP_TARGETS: StampTargets = { s: [], t: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What the storefront runtime may stamp: the union over enabled template / section_shown / experiment
 * conditions of the offers passed in (the caller passes live offers only). Sorted, deduped and capped, so
 * the metafield is deterministic and compact. `e` is omitted when empty; empty targets mean nothing is stamped.
 */
export function collectStampTargets(conditions: Iterable<{ isEnabled: boolean; conditionType: string; value: unknown }>): StampTargets {
  const s = new Set<string>();
  const t = new Set<string>();
  const e = new Set<string>();
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  for (const c of conditions) {
    if (!c.isEnabled || !isRecord(c.value)) continue;
    if (c.conditionType === "template") {
      for (const ref of strings(c.value["templates"])) if (TEMPLATE_REF_PATTERN.test(ref.toLowerCase())) t.add(ref.toLowerCase());
    } else if (c.conditionType === "section_shown") {
      for (const section of Array.isArray(c.value["sections"]) ? c.value["sections"] : []) {
        if (!isRecord(section) || typeof section["template"] !== "string" || typeof section["key"] !== "string") continue;
        const template = section["template"].toLowerCase();
        if (TEMPLATE_REF_PATTERN.test(template) && SECTION_KEY_PATTERN.test(section["key"])) s.add(`${template}/${section["key"]}`);
      }
    } else if (c.conditionType === "experiment") {
      const id = c.value["experimentId"];
      if (typeof id === "string" && EXPERIMENT_ID_PATTERN.test(id) && strings(c.value["variantKeys"]).some((k) => VARIANT_KEY_PATTERN.test(k))) e.add(id);
    }
  }
  const out = (set: Set<string>, cap: number) => [...set].sort().slice(0, cap);
  const targets: StampTargets = { s: out(s, STAMP_TARGET_CAPS.s), t: out(t, STAMP_TARGET_CAPS.t) };
  if (e.size > 0) targets.e = out(e, STAMP_TARGET_CAPS.e);
  return targets;
}
