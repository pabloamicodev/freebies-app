import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";

/** Parsed representation of a gift line for quick lookup. */
export interface GiftLineInfo {
  lineKey: string;
  variantId: string;
  offerId: string;
  rewardId: string;
  offerVersion: string;
  hash: string;
  quantity: number;
}

/** Parse all gift lines from a normalized cart. */
export function extractGiftLines(cart: NormalizedCart): GiftLineInfo[] {
  const gifts: GiftLineInfo[] = [];
  for (const line of cart.lines) {
    const lineType = line.properties["_promo_engine_line_type"];
    if (lineType !== "gift") continue;

    const offerId = line.properties["_promo_engine_offer_id"] ?? "";
    const rewardId = line.properties["_promo_engine_reward_id"] ?? "";
    const offerVersion = line.properties["_promo_engine_offer_version"] ?? "";
    const hash = line.properties["_promo_engine_hash"] ?? "";

    if (!offerId || !rewardId) continue;

    gifts.push({
      lineKey: line.key,
      variantId: line.variantId,
      offerId,
      rewardId,
      offerVersion,
      hash,
      quantity: line.quantity,
    });
  }
  return gifts;
}

/** Non-gift, non-bundle cart lines — the lines used for eligibility evaluation. */
export function extractQualifyingLines(
  cart: NormalizedCart,
  options: { includeGiftValues: boolean } = { includeGiftValues: false },
): NormalizedCartLine[] {
  return cart.lines.filter((line) => {
    const lineType = line.properties["_promo_engine_line_type"];
    if (!options.includeGiftValues && lineType === "gift") return false;
    return true;
  });
}

/** Sum of (price × quantity) across qualifying lines, in cents. */
export function sumQualifyingValue(lines: NormalizedCartLine[]): number {
  return lines.reduce((acc, line) => acc + line.priceCents * line.quantity, 0);
}

/** Total qualifying item count across lines. */
export function sumQualifyingQuantity(lines: NormalizedCartLine[]): number {
  return lines.reduce((acc, line) => acc + line.quantity, 0);
}

/** Build a SHA-256 deterministic cart hash from variant IDs + quantities + discount codes. */
export async function buildCartHash(cart: NormalizedCart): Promise<string> {
  const parts = [
    ...cart.lines
      .map((l) => `${l.variantId}:${l.quantity}`)
      .sort(),
    ...cart.discountCodes.slice().sort(),
    cart.currencyCode,
  ];
  const input = parts.join("|");
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
