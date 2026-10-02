// ─── Subcondition type definitions ───────────────────────────────────────────
// Add new subcondition IDs here as the product grows.

import { FUNCTION_ENFORCED_CONDITION_TYPES, type ConditionType } from "@promo/shared-types";

export type SubconditionId =
  | "link"
  | "order_history"
  | "customer_tags"
  | "location"
  | "subscription"
  | "sales_channel"
  | "markets"
  | "custom_attribute"
  | "quantity_limit"
  | "utm_parameters"
  | "page_types";

/** The stored condition types each picker entry can produce (see normalizeOfferSubconditions). */
export const SUBCONDITION_CONDITION_TYPES: Record<SubconditionId, ConditionType[]> = {
  link: ["specific_link"],
  order_history: [
    "order_history_total_spent",
    "order_history_last_order_spent",
    "order_history_total_orders",
    "one_use_per_customer",
  ],
  customer_tags: ["customer_tags"],
  location: ["customer_location"],
  subscription: ["subscription_product_type"],
  sales_channel: ["sales_channels"],
  markets: ["markets"],
  custom_attribute: ["line_attribute", "cart_attribute"],
  quantity_limit: ["cart_quantity", "specific_product"],
  utm_parameters: ["utm_parameters"],
  page_types: ["page_types"],
};

/** Entries checkout can actually enforce for at least one of their modes; the rest can never publish on a code offer. */
export function isFunctionEnforcedSubcondition(id: SubconditionId): boolean {
  return SUBCONDITION_CONDITION_TYPES[id].some((type) => FUNCTION_ENFORCED_CONDITION_TYPES.has(type));
}

export interface SubconditionDef {
  id: SubconditionId;
  name: string;
  desc: string;
  plus: boolean;
}

// ─── Offer-type specific sets ─────────────────────────────────────────────────
// Each offer type can expose all or a subset of subconditions.

const ALL_SUBCONDITIONS: SubconditionDef[] = [
  {
    id: "link",
    name: "Specific link address",
    desc: "Customers only receive gifts if they arrive through a special link",
    plus: false,
  },
  {
    id: "order_history",
    name: "Customer order history",
    desc: "Customers must meet order history requirements.",
    plus: false,
  },
  {
    id: "customer_tags",
    name: "Customer tags",
    desc: "Customers can only receive gifts if they have the right customer tag",
    plus: false,
  },
  {
    id: "location",
    name: "Customer location",
    desc: "Customers can only receive gifts if they're from specific countries.",
    plus: false,
  },
  {
    id: "subscription",
    name: "Subscription products",
    desc: "Condition based on subscription products.",
    plus: false,
  },
  {
    id: "sales_channel",
    name: "Sales channels",
    desc: "Condition for purchases from the mobile app or POS sales channel",
    plus: false,
  },
  {
    id: "markets",
    name: "Markets",
    desc: "Condition by Shopify Markets to segment by region.",
    plus: false,
  },
  {
    id: "custom_attribute",
    name: "Store custom field",
    desc: "Condition on a line property or cart attribute defined by this store.",
    plus: false,
  },
  {
    id: "quantity_limit",
    name: "Product quantity limits",
    desc: "Limits the gift based on the quantity of specific products in the cart.",
    plus: false,
  },
  {
    id: "utm_parameters",
    name: "UTM Parameters",
    desc: "Only applies to customers who arrived via specific UTM tracking parameters (utm_source, utm_medium, etc.) — captured automatically from their landing URL, no landing-page snippet needed.",
    plus: false,
  },
  {
    id: "page_types",
    name: "Store pages",
    desc: "Only counts products added to the cart from certain kinds of pages, like product pages or collections.",
    plus: false,
  },
];

// Convenience: gift and discount offers use the full set.
// Bundle / upsell can narrow this down if needed.
export const GIFT_SUBCONDITIONS = ALL_SUBCONDITIONS;
