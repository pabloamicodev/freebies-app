import { SLOT_LIMITS } from "./sync/slot-limits.js";

export const SHOPIFY_AUTOMATIC_LIMIT = 25;

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

export function sharedConfigTooLargeMessage(bytes: number, names: readonly string[] = []): string {
  const base = `The shared automatic config would be ${bytes}B, over the ${SLOT_LIMITS.slotBytes}B limit. Pause or simplify other automatic offers first.`;
  return names.length > 0 ? `${base} Offers that don't fit: ${quoted(names)}.` : base;
}

export const combinationSingleShardTitle = "Discount combinations limit how many offers can run";

export function combinationSingleShardMessage(names: readonly string[]): string {
  return `${names.length} active offers don't combine with other product discounts, so all offers must share one Shopify discount, and it's full. Allow those offers to combine with product discounts, or pause some offers. Offers: ${quoted(names)}.`;
}

export function shippingConfigTooLargeMessage(bytes: number): string {
  return `The shipping config would be ${bytes}B, over the ${SLOT_LIMITS.slotBytes}B limit. Pause or simplify other shipping offers first.`;
}

export function validationConfigTooLargeMessage(bytes: number, limit: number): string {
  return `The cart validation config would be ${bytes}B, over the ${limit}B limit. Pause or simplify active gift offers first.`;
}

export function automaticDiscountLimitMessage(storeActive: number, needed: number): string {
  return `Shopify allows ${SHOPIFY_AUTOMATIC_LIMIT} active automatic discounts per store. Your store has ${storeActive} active and Promo Engine needs ${needed} more. Deactivate or delete some automatic discounts in Shopify, or pause offers, then publish again.`;
}

export function automaticDiscountCountUnknownMessage(): string {
  return `Promo Engine couldn't read how many automatic discounts your store has. Try again in a minute; Shopify allows ${SHOPIFY_AUTOMATIC_LIMIT} active automatic discounts per store.`;
}

export function slot0GroupTooLargeMessage(count: number, names: readonly string[] = []): string {
  const base = `${count} offers with order discounts or 'stop lower priority' must share one Shopify discount and don't fit. Pause or simplify some of them.`;
  return names.length > 0 ? `${base} Offers involved: ${quoted(names)}.` : base;
}

export type TooLargeReason = "bytes" | "keys" | "tags";

export function offerTooLargeMessage(
  names: readonly string[],
  reason: TooLargeReason,
  numbers: Record<string, number>,
  group = false,
): string {
  const who = quoted(names);
  if (group) {
    return `${who} must share one Shopify discount and together exceed its ${
      reason === "bytes"
        ? `${numbers["slotBytes"]}B size limit (${numbers["bytes"]}B)`
        : reason === "keys"
          ? `${numbers["maxKeys"]} cart attribute limit (${numbers["keys"]} used)`
          : `${numbers["maxTags"]} customer tag limit (${numbers["tags"]} used)`
    }. Pause or simplify some of them.`;
  }
  if (reason === "keys") {
    const keys = numbers["keys"] ?? 0;
    const max = numbers["maxKeys"] ?? SLOT_LIMITS.maxKeys;
    return `${who} checks ${keys} cart attributes. Shopify lets a discount read at most ${max}. Remove ${keys - max} cart attribute conditions.`;
  }
  if (reason === "tags") {
    return `${who} references ${numbers["tags"]} customer tags. Shopify allows up to ${numbers["maxTags"] ?? SLOT_LIMITS.maxTags} per discount.`;
  }
  return `${who} is too large for one Shopify discount (${numbers["bytes"]}B, limit ${numbers["slotBytes"] ?? SLOT_LIMITS.slotBytes}B). Select fewer products or variants, or simplify its tiers.`;
}
