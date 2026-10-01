import type { NormalizedCart, NormalizedCartLine } from "@promo/shared-types";

/** Parsed representation of a gift line for quick lookup. */
export interface GiftLineInfo {
  lineKey: string;
  variantId: string;
  offerId: string;
  rewardId: string;
  offerVersion: string;
  quantity: number;
}

/** Parse all gift lines from a normalized cart. Tamper protection lives at
 * checkout: the Discount Function only discounts a gift line whose variant is
 * actually in that offer's configured gift list, regardless of what a buyer
 * edits into these line properties client-side. */
export function extractGiftLines(cart: NormalizedCart): GiftLineInfo[] {
  const gifts: GiftLineInfo[] = [];
  for (const line of cart.lines) {
    const lineType = line.properties["_promo_engine_line_type"];
    if (lineType !== "gift") continue;

    const offerId = line.properties["_promo_engine_offer_id"] ?? "";
    const rewardId = line.properties["_promo_engine_reward_id"] ?? "";
    const offerVersion = line.properties["_promo_engine_offer_version"] ?? "";

    if (!offerId || !rewardId) continue;

    gifts.push({
      lineKey: line.key,
      variantId: line.variantId,
      offerId,
      rewardId,
      offerVersion,
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
    const isGift =
      lineType === "gift"
      || line.properties["__cart_gift_tier"] !== undefined
      || line.properties["_quiz_free_gift"] === "true";
    if (!options.includeGiftValues && isGift) return false;
    return true;
  });
}

/** Sum of final line subtotals across qualifying lines, in cents. */
export function sumQualifyingValue(lines: NormalizedCartLine[]): number {
  return lines.reduce(
    (acc, line) => acc + (line.lineSubtotalCents ?? line.priceCents * line.quantity),
    0,
  );
}

/**
 * Discount a separate store volume-discount Function will apply, projected per
 * product (qty-summed best tier, percent of the group's line subtotals). Mirrors
 * the discount Function's projected_volume_discount_cents and the legacy
 * projectedVolumeDiscountCents: gift lines, `_bundle_item=="true"` and any
 * `_nektar_glp1` line never count.
 */
export function projectedVolumeDiscountCents(lines: NormalizedCartLine[]): number {
  const groups = new Map<string, { quantity: number; subtotal: number; tiers: { qty: number; percent: number }[] }>();
  for (const line of lines) {
    const tiers = line.volumeDiscountTiers;
    if (!tiers?.length) continue;
    const props = line.properties;
    if (
      props["_promo_engine_line_type"] === "gift"
      || props["__cart_gift_tier"]
      || props["_quiz_free_gift"] === "true"
      || props["_bundle_item"] === "true"
      || props["_nektar_glp1"]
    ) continue;
    const subtotal = line.lineSubtotalCents ?? line.priceCents * line.quantity;
    if (subtotal <= 0) continue;
    const group = groups.get(line.productId) ?? { quantity: 0, subtotal: 0, tiers: [] };
    group.quantity += line.quantity;
    group.subtotal += subtotal;
    group.tiers.push(...tiers);
    groups.set(line.productId, group);
  }
  let total = 0;
  for (const group of groups.values()) {
    const best = group.tiers
      .filter((tier) => tier.percent > 0 && group.quantity >= tier.qty)
      .sort((a, b) => b.qty - a.qty || b.percent - a.percent)[0];
    if (best) total += Math.round((group.subtotal * best.percent) / 100);
  }
  return total;
}

/** Qualifying cart value: line subtotals net of the projected volume discount. */
export function sumQualifyingValueNet(lines: NormalizedCartLine[]): number {
  return Math.max(0, sumQualifyingValue(lines) - projectedVolumeDiscountCents(lines));
}

/** Total qualifying item count across lines. */
export function sumQualifyingQuantity(lines: NormalizedCartLine[]): number {
  return lines.reduce((acc, line) => acc + line.quantity, 0);
}

/** Build a SHA-256 deterministic cart hash from all eligibility-relevant cart data. */
export async function buildCartHash(cart: NormalizedCart): Promise<string> {
  const parts = [
    ...cart.lines
      .map((line) => {
        const properties = Object.entries(line.properties)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join(",");
        return [
          line.key,
          line.variantId,
          line.quantity,
          line.priceCents,
          line.lineSubtotalCents ?? line.priceCents * line.quantity,
          line.sellingPlanId ?? "",
          properties,
        ].join(":");
      })
      .sort(),
    ...cart.discountCodes.slice().sort(),
    String(cart.subtotalCents),
    cart.currencyCode,
  ];
  const input = parts.join("|");
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
