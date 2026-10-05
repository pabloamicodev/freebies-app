/** Shopify truncates long discount messages; the compiled config carries at most this many characters. */
export const DISCOUNT_MESSAGE_MAX_LENGTH = 60;

export type DiscountMessageResult = { ok: true; value: string } | { ok: false; error: string };

/** Empty input falls back to `fallback` (the offer name); over-limit input is rejected. */
export function resolveDiscountMessage(raw: unknown, fallback: string): DiscountMessageResult {
  const value = (typeof raw === "string" ? raw : "").trim() || fallback.trim();
  if (value.length > DISCOUNT_MESSAGE_MAX_LENGTH) {
    return { ok: false, error: `Discount message can be at most ${DISCOUNT_MESSAGE_MAX_LENGTH} characters.` };
  }
  return { ok: true, value };
}

/** Defensive clamp for what reaches the Function config, e.g. legacy titles saved before the limit. */
export function clampDiscountMessage(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? Array.from(trimmed).slice(0, DISCOUNT_MESSAGE_MAX_LENGTH).join("") : undefined;
}
