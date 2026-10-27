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
