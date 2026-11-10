import { UNPACKABLE_LISTS } from "./sync/compile-config.js";
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

/** W1: wizard note under an unchecked "Product discounts" box while combination groups are on. */
export const combinationGroupsWizardNote =
  "Offers that don't combine with product discounts run in their own Shopify discount once your store has many offers. Shopify then won't stack this offer with other product discounts, including other Promo Engine offers. The customer gets whichever is better.";

/** W2: Diagnostics > Shopify limits > Combination groups. */
export function combinationGroupsMessage(nonCombining: number, nodes: number, combining: number): string {
  const offers = nonCombining === 1 ? "1 offer that doesn't combine runs" : `${nonCombining} offers that don't combine run`;
  const discounts = nodes === 1 ? "1 Shopify discount" : `${nodes} Shopify discounts`;
  const others = combining === 1 ? "your other offer" : `your other ${combining} offers`;
  return `${offers} in ${discounts}. They no longer stack with ${others}, and those offers now combine with Shopify and other apps' product discounts when both allow it.`;
}

export type CombinationForcedReason = "order_reward" | "stop_lower_priority" | "linked_offer";

export const combinationForcedReasonLabel: Record<CombinationForcedReason, string> = {
  order_reward: "has an order reward",
  stop_lower_priority: "is below a 'Stop lower-priority offers' offer",
  linked_offer: "must run together with an offer that doesn't combine",
};

/** W3: confirmation before letting offers that don't combine run in their own Shopify discount. */
export const combinationDomainsConfirm = {
  title: "Let offers that don't combine run separately?",
  body: "Your offers no longer fit in one Shopify discount. Offers that don't combine with product discounts will run in their own Shopify discount, so a cart that qualifies for one of them and for another offer gets the better of the two instead of both. Offers that combine will also combine with discount codes and other discounts that allow it.",
  allow: "Allow",
  keep: "Keep one discount",
} as const;

export const combinationDomainsOffNote =
  "Offers that don't combine force every offer into one Shopify discount, so a full discount blocks publishing. Turn this on to let them run separately.";

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

export type TooLargeReason = "bytes" | "keys" | "tags" | "offers" | "lists";

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
          : reason === "offers"
            ? `${numbers["maxOffers"]} offer limit (${numbers["offers"]} used)`
            : `${numbers["maxTags"]} customer tag limit (${numbers["tags"]} used)`
    }. Pause or simplify some of them.`;
  }
  if (reason === "keys") {
    const keys = numbers["keys"] ?? 0;
    const max = numbers["maxKeys"] ?? SLOT_LIMITS.maxKeys;
    return `${who} checks ${keys} cart attributes. Shopify lets a discount read at most ${max}. Remove ${keys - max} cart attribute conditions.`;
  }
  if (reason === "lists") {
    const label = UNPACKABLE_LISTS[numbers["listKind"] ?? -1]?.[1] ?? "entries";
    return `Shopify limit: a Promo Engine discount can't receive a list with more than ${numbers["listLimit"] ?? 100} entries. ${who || "This discount"} has ${numbers["listCount"]} ${label}. Reduce it to ${numbers["listLimit"] ?? 100} or split the offer into two.`;
  }
  if (reason === "tags") {
    return `${who} references ${numbers["tags"]} customer tags. Shopify allows up to ${numbers["maxTags"] ?? SLOT_LIMITS.maxTags} per discount.`;
  }
  return `${who} is too large for one Shopify discount (${numbers["bytes"]}B, limit ${numbers["slotBytes"] ?? SLOT_LIMITS.slotBytes}B). Select fewer products or variants, or simplify its tiers.`;
}
