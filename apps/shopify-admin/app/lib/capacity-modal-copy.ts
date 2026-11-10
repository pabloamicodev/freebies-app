import {
  SHOPIFY_AUTOMATIC_LIMIT,
  automaticDiscountCountUnknownMessage,
  combinationSingleShardMessage,
  combinationSingleShardTitle,
  combinationGroupsWizardNote,
  offerTooLargeMessage,
  sharedConfigTooLargeMessage,
  slot0GroupTooLargeMessage,
  type TooLargeReason,
} from "./capacity-copy.js";
import { SLOT_LIMITS } from "./sync/slot-limits.js";

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
  /** OFFER_TOO_LARGE: why Promo Engine could not split the offer across several Shopify discounts. */
  splitRefusal?: string;
  /** Shopify admin page listing the store's automatic discounts. */
  discountsUrl?: string;
}

export type CapacityModalAction =
  | { kind: "external"; label: string; href: string }
  | { kind: "offer"; label: string; to: string }
  | { kind: "settings"; label: string; to: string };

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

const over = (used: number | undefined, max: number | undefined) => used !== undefined && max !== undefined && used > max;

/** The planner reports every measure in `numbers`, so only the one that is over its limit names the reason. */
export function tooLargeReason(numbers: Record<string, number>): TooLargeReason {
  if (numbers["listKind"] !== undefined) return "lists";
  if (over(numbers["offers"], numbers["maxOffers"])) return "offers";
  if (over(numbers["keys"], numbers["maxKeys"])) return "keys";
  if (over(numbers["tags"], numbers["maxTags"])) return "tags";
  return "bytes";
}

export const SPLIT_REFUSAL_COPY:Record<string, string> = {
  AGGREGATING_REWARD: "Promo Engine can't split it across several Shopify discounts because its discount counts quantities, tiers or prices across all the selected items.",
  CART_WIDE_CAP: "Promo Engine can't split it across several Shopify discounts because it caps the discounted units for the whole cart.",
  REQUIRED_TAGS_ALL_OF: "Promo Engine can't split it across several Shopify discounts because customers must have all of the required tags.",
  EXCLUDED_TAGS: "Promo Engine can't split it across several Shopify discounts because it excludes customers by tag.",
  ALL_OF_CONDITION: "Promo Engine can't split it across several Shopify discounts because it requires every selected item to be in the cart.",
  REQUIRED_IDS: "Promo Engine can't split it across several Shopify discounts because of the products it requires in the cart.",
  EXCLUDED_PRODUCTS: "Promo Engine can't split it across several Shopify discounts because of its excluded products.",
  GIFT_PICKER: "Promo Engine can't split it across several Shopify discounts because customers choose their gift from the list.",
  GIFT_REWARDS_OVERLAP: "Promo Engine can't split it across several Shopify discounts because its gifts share products.",
  GIFT_TIER_HIGHEST: "Promo Engine can't split it across several Shopify discounts because only the highest gift tier applies.",
  GIFT_ANCHOR_OVERLAP: "Promo Engine can't split it across several Shopify discounts because a gift is also one of the products that unlock it.",
  LANDING_SELF_ANCHOR: "Promo Engine can't split it across several Shopify discounts because any tagged product unlocks it. Choose the products that unlock it to allow that.",
  ANCHOR_MIN_QUANTITY: "Promo Engine can't split it across several Shopify discounts because it needs more than one unlocking item.",
  STOP_LOWER_PRIORITY: "Promo Engine can't split it across several Shopify discounts because it stops lower-priority offers.",
  ORDER_REWARDS: "Promo Engine can't split it across several Shopify discounts because it discounts the whole order.",
  QUIZ_BUNDLE: "Promo Engine can't split a quiz bundle across several Shopify discounts.",
  ANCHOR_CONSUMPTION: "Promo Engine can't split it across several Shopify discounts because its unlocking items can't unlock other gifts.",
  VARIANT_PRODUCT_UNKNOWN: "Promo Engine can't split it yet because some selected variants are not synced. Sync your products and try again.",
  STILL_TOO_LARGE: "Even split across several Shopify discounts, a part of it would still be too large.",
};

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
      if (reason === "lists") {
        return {
          title: "This offer has a list that is too long",
          limit: `Shopify doesn't let a discount receive a list with more than ${numbers["listLimit"] ?? 100} entries.`,
          body,
          fix: "Shorten the list to 100 entries or split the offer into two, then try again.",
          actions: data.offers.slice(0, MAX_OFFER_ACTIONS).map((offer) => ({ kind: "offer", label: `Open ${offer.name}`, to: `/app/offers/${offer.id}` })),
        };
      }
      if (reason === "offers") {
        return {
          title: "Too many offers must share one Shopify discount",
          limit: `Shopify doesn't let a discount receive a list with more than ${numbers["maxOffers"] ?? SLOT_LIMITS.maxOffers} entries, and each offer is one entry.`,
          body,
          fix: "Pause or simplify some of these offers, then try again.",
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
        body: data.splitRefusal && SPLIT_REFUSAL_COPY[data.splitRefusal] ? `${body} ${SPLIT_REFUSAL_COPY[data.splitRefusal]}` : body,
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
        fix: "Let those offers run in their own Shopify discount, allow them to combine with product discounts, or pause some offers.",
        actions: [
          { kind: "settings", label: "Let them run separately…", to: "/app/diagnostics?combination=allow" },
          ...data.offers
            .slice(0, MAX_OFFER_ACTIONS)
            .map((offer): CapacityModalAction => ({ kind: "offer", label: `Open ${offer.name}`, to: `/app/offers/${offer.id}/combination` })),
        ],
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
/** Note under the unchecked "Product discounts" box: which behavior applies depends on the combination-groups setting. */
export const combinationWizardNote = (domainsEnabled: boolean): string =>
  domainsEnabled ? combinationGroupsWizardNote : combinationOptOutWarning;

export function productDiscountsField(templateId: string, shardsEnabled: boolean): { visible: boolean; checked: boolean } {
  const visible = shardsEnabled || templateId === "cart";
  return { visible, checked: visible };
}
