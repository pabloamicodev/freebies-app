import {
  SHOPIFY_AUTOMATIC_LIMIT,
  automaticDiscountCountUnknownMessage,
  combinationSingleShardMessage,
  combinationSingleShardTitle,
  offerTooLargeMessage,
  sharedConfigTooLargeMessage,
  slot0GroupTooLargeMessage,
  type TooLargeReason,
} from "./capacity-copy.js";
import { SLOT_LIMITS } from "./sync/shard-planner.js";

export const CAPACITY_MODAL_CODES = [
  "AUTOMATIC_DISCOUNT_LIMIT",
  "OFFER_TOO_LARGE",
  "GROUP_TOO_LARGE",
  "SLOT0_GROUP_TOO_LARGE",
  "SLOT_FULL",
  "COMBINATION_SINGLE_SHARD",
] as const;

export type CapacityModalCode = (typeof CAPACITY_MODAL_CODES)[number];

export function isCapacityModalCode(code: string): code is CapacityModalCode {
  return (CAPACITY_MODAL_CODES as readonly string[]).includes(code);
}

export interface CapacityModalOffer {
  id: string;
  name: string;
}

/** Serializable payload an action returns next to its `error` so the UI can open the Shopify-limit modal. */
export interface CapacityModalData {
  code: CapacityModalCode;
  offers: CapacityModalOffer[];
  numbers: Record<string, number>;
  /** Shopify admin page listing the store's automatic discounts. */
  discountsUrl?: string;
}

export type CapacityModalAction =
  | { kind: "external"; label: string; href: string }
  | { kind: "offer"; label: string; to: string };

export interface CapacityModalCopy {
  title: string;
  /** Which Shopify limit was hit. */
  limit: string;
  /** What happened, with the offers involved. */
  body: string;
  /** What to do. */
  fix: string;
  actions: CapacityModalAction[];
}

const MAX_OFFER_ACTIONS = 3;

function tooLargeReason(numbers: Record<string, number>): TooLargeReason {
  if (numbers["keys"] !== undefined && numbers["maxKeys"] !== undefined) return "keys";
  if (numbers["tags"] !== undefined && numbers["maxTags"] !== undefined) return "tags";
  return "bytes";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeCapacityModal(data: CapacityModalData): CapacityModalCopy {
  const names = data.offers.map((offer) => offer.name);
  const { numbers } = data;
  const slotBytes = numbers["slotBytes"] ?? SLOT_LIMITS.slotBytes;
  const reviewDiscounts: CapacityModalAction[] = data.discountsUrl
    ? [{ kind: "external", label: "Review automatic discounts", href: data.discountsUrl }]
    : [];

  switch (data.code) {
    case "AUTOMATIC_DISCOUNT_LIMIT": {
      const needed = numbers["needed"] ?? 1;
      const storeActive = numbers["storeActive"];
      const others = numbers["others"];
      return {
        title: "Shopify's automatic discount limit is reached",
        limit: `Shopify allows ${SHOPIFY_AUTOMATIC_LIMIT} active automatic discounts per store, including discounts from other apps.`,
        body:
          storeActive === undefined
            ? automaticDiscountCountUnknownMessage()
            : `Activating this offer needs ${plural(needed, "more automatic discount")} in Shopify. Your store has ${storeActive} of ${SHOPIFY_AUTOMATIC_LIMIT} active${others === undefined ? "" : ` (${others} from other apps or Shopify)`}.`,
        fix: "Deactivate an automatic discount you no longer use, then try again. Your other offers keep running.",
        actions: reviewDiscounts,
      };
    }
    case "OFFER_TOO_LARGE":
    case "GROUP_TOO_LARGE": {
      const reason = tooLargeReason(numbers);
      const group = data.code === "GROUP_TOO_LARGE";
      const body = offerTooLargeMessage(names, reason, numbers, group);
      if (reason === "keys") {
        return {
          title: "This offer reads too many cart attributes",
          limit: `Shopify lets one discount read at most ${numbers["maxKeys"] ?? SLOT_LIMITS.maxKeys} cart attributes.`,
          body,
          fix: "Remove cart attribute conditions from the offer, then try again.",
          actions: [],
        };
      }
      if (reason === "tags") {
        return {
          title: "This offer references too many customer tags",
          limit: `Shopify allows up to ${numbers["maxTags"] ?? SLOT_LIMITS.maxTags} customer tags per discount.`,
          body,
          fix: "Remove some customer tags from the offer, then try again.",
          actions: [],
        };
      }
      return {
        title: group ? "These offers are too large for one Shopify discount" : "This offer has too many items for one Shopify discount",
        limit: `One Shopify discount holds up to ${slotBytes.toLocaleString("en-US")} bytes of offer configuration (roughly 200 variants).`,
        body,
        fix: "Select fewer products or variants, select whole products instead of variants, or simplify the offer's tiers. Save it as a draft to keep your work.",
        actions: [],
      };
    }
    case "SLOT0_GROUP_TOO_LARGE":
      return {
        title: "Offers that stop lower-priority offers are too large together",
        limit: `Offers with order discounts, and offers that stop lower-priority offers, run in one Shopify discount that holds up to ${slotBytes.toLocaleString("en-US")} bytes.`,
        body: slot0GroupTooLargeMessage(numbers["groupUnits"] ?? names.length, names),
        fix: "Turn off 'Stop lower-priority offers' on one of them, lower its priority, or pause or simplify some of these offers.",
        actions: data.offers.slice(0, MAX_OFFER_ACTIONS).map((offer) => ({ kind: "offer", label: `Open ${offer.name}`, to: `/app/offers/${offer.id}` })),
      };
    case "SLOT_FULL":
      return {
        title: "Shopify's discount size limit is reached",
        limit: `One Shopify automatic discount holds up to ${slotBytes.toLocaleString("en-US")} bytes of offer configuration.`,
        body: sharedConfigTooLargeMessage(numbers["neededBytes"] ?? numbers["bytes"] ?? 0, names),
        fix: "Pause or simplify other automatic offers, then try again.",
        actions: [],
      };
    case "COMBINATION_SINGLE_SHARD":
      return {
        title: combinationSingleShardTitle,
        limit: `Offers that don't combine with product discounts must share one Shopify discount, which holds up to ${slotBytes.toLocaleString("en-US")} bytes.`,
        body: combinationSingleShardMessage(names),
        fix: "Allow those offers to combine with product discounts, or pause some offers.",
        actions: data.offers
          .slice(0, MAX_OFFER_ACTIONS)
          .map((offer) => ({ kind: "offer", label: `Open ${offer.name}`, to: `/app/offers/${offer.id}/combination` })),
      };
  }
}

/** Inline note under a "combines with product discounts" checkbox that a sharded shop just unchecked. */
export const combinationOptOutWarning = `This offer will force all offers into one Shopify discount, which holds about ${SLOT_LIMITS.slotBytes.toLocaleString("en-US")} bytes. Offers that don't combine with product discounts can't be spread over several Shopify discounts, so a full discount blocks publishing.`;

/**
 * "Product discounts" checkbox in the discount wizard. Sharded shops need offers that combine with product
 * discounts, so it is shown for every template and starts checked; unsharded shops keep today's behaviour
 * (shown for cart-discount offers only, so other templates save as not combining).
 */
export function productDiscountsField(templateId: string, shardsEnabled: boolean): { visible: boolean; checked: boolean } {
  const visible = shardsEnabled || templateId === "cart";
  return { visible, checked: visible };
}
