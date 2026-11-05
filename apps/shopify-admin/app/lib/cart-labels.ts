export const CART_LABEL_MAX_COUNT = 3;
export const CART_LABEL_MAX_LENGTH = 40;
export const CART_MESSAGE_MAX_LENGTH = 64;
const SEPARATOR = " · ";

export type CartLabelsResult = { ok: true; labels: string[] } | { ok: false; error: string };

/** Trims, drops empties and duplicates; over-limit input is rejected rather than silently cut. */
export function resolveCartLabels(raw: unknown): CartLabelsResult {
  let input = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return { ok: true, labels: [] };
    try {
      input = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Cart & checkout labels are invalid." };
    }
  }
  if (input === undefined || input === null) return { ok: true, labels: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Cart & checkout labels are invalid." };
  const labels = [...new Set(input.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
  if (labels.length > CART_LABEL_MAX_COUNT) {
    return { ok: false, error: `Use at most ${CART_LABEL_MAX_COUNT} cart & checkout labels.` };
  }
  if (labels.some((label) => Array.from(label).length > CART_LABEL_MAX_LENGTH)) {
    return { ok: false, error: `Each cart & checkout label can be at most ${CART_LABEL_MAX_LENGTH} characters.` };
  }
  return { ok: true, labels };
}

/** Defensive read of stored labels: never throws, always within the limits. */
export function readCartLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => Array.from(v.trim()).slice(0, CART_LABEL_MAX_LENGTH).join(""))
    .filter(Boolean)
    .slice(0, CART_LABEL_MAX_COUNT);
}

export function clampCartMessage(message: string): string {
  return Array.from(message).slice(0, CART_MESSAGE_MAX_LENGTH).join("");
}

/** "Title · A · B" (Function `cartMessage`); undefined when there are no labels, so old configs stay byte-identical. */
export function compileOfferCartMessage(title: string | undefined, labels: unknown): string | undefined {
  const clean = readCartLabels(labels);
  if (clean.length === 0) return undefined;
  return clampCartMessage([...(title ? [title] : []), ...clean].join(SEPARATOR));
}

/** Tier `cartMessage`: labels joined; undefined when the tier has none (the Function builds the fallback). */
export function compileTierCartMessage(labels: unknown): string | undefined {
  const clean = readCartLabels(labels);
  return clean.length === 0 ? undefined : clampCartMessage(clean.join(SEPARATOR));
}
