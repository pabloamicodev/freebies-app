import { ConditionTypeSchema, type ConditionType } from "./offers.js";

/**
 * Single source of truth for which eligibility condition types (scope
 * "main"/"sub") the Shopify Function actually re-verifies at checkout.
 *
 * `offer-publish-flow.server.ts` blocks publishing an offer whose eligibility
 * depends on a condition type that isn't enforced here — otherwise
 * client-controlled metadata (a fake order-history claim, a spoofed tag,
 * etc.) could unlock a discount the Function never re-checks.
 * `compile-config.ts` compiles every enforced type (except "markets", which
 * is rewritten to "customer_location" before compilation — see
 * `market-condition-resolution.server.ts`) into the Function config.
 *
 * This is a `Record<ConditionType, ...>` literal on purpose: adding a new
 * entry to `ConditionTypeSchema` without adding it here is a TypeScript
 * compile error, not a silently-missed case in some far-away switch
 * statement.
 */
export const CONDITION_REGISTRY: Record<ConditionType, { enforcedByFunction: boolean }> = {
  cart_value: { enforcedByFunction: true },
  cart_quantity: { enforcedByFunction: true },
  specific_product: { enforcedByFunction: true },
  cart_value_multiplier: { enforcedByFunction: false },
  pack_of_products: { enforcedByFunction: true },
  specific_link: { enforcedByFunction: true },
  order_history_total_spent: { enforcedByFunction: true },
  order_history_last_order_spent: { enforcedByFunction: false },
  order_history_total_orders: { enforcedByFunction: true },
  one_use_per_customer: { enforcedByFunction: false },
  customer_tags: { enforcedByFunction: true },
  customer_location: { enforcedByFunction: true },
  markets: { enforcedByFunction: true },
  subscription_product_type: { enforcedByFunction: true },
  sales_channels: { enforcedByFunction: false },
  product_quantity_limits: { enforcedByFunction: false },
  collection_quantity_limits: { enforcedByFunction: false },
  vendor_quantity_limits: { enforcedByFunction: false },
  product_type_quantity_limits: { enforcedByFunction: false },
  exclude_products: { enforcedByFunction: true },
  exclude_collections: { enforcedByFunction: false },
  exclude_vendors: { enforcedByFunction: false },
  exclude_types: { enforcedByFunction: false },
  page_url: { enforcedByFunction: true },
  line_attribute: { enforcedByFunction: true },
  cart_attribute: { enforcedByFunction: true },
  // Replaced by per-offer discount codes (discount_codes table); only legacy rows still carry this type.
  discount_code: { enforcedByFunction: false },
  utm_parameters: { enforcedByFunction: true },
};

export const FUNCTION_ENFORCED_CONDITION_TYPES: ReadonlySet<ConditionType> = new Set(
  ConditionTypeSchema.options.filter((type) => CONDITION_REGISTRY[type].enforcedByFunction),
);
