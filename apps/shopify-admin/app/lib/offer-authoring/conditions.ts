import { z } from "zod";
import { CART_ATTRIBUTE_KEYS, LINE_ATTRIBUTE_KEYS, PAGE_TYPES, ConditionScopeSchema, type ConditionScope } from "@promo/shared-types";
import { buildConditionValue, type ConditionInput } from "../offer-conditions.server.js";
import type { StoredCondition, ToStored } from "./types.js";

/**
 * Authoring shape of offer conditions for agents/MCP: money in MAJOR units of the shop currency (50 = $50.00),
 * ids as numeric ids or GIDs, flat fields per type. `toStoredConditions` turns them into offer_conditions rows
 * with the same builder + validator the admin editor uses. `discount_code` is not a condition (it lives on the
 * Codes tab) and is intentionally absent.
 */

const gid = (kind: "Market" | "Product" | "ProductVariant") => (value: string) => {
  const v = value.trim();
  return /^\d+$/.test(v) ? `gid://shopify/${kind}/${v}` : v;
};

const scope = ConditionScopeSchema.optional().describe(
  "main (default for cart/product/page conditions) | sub (default for customer/market/channel conditions; extra gates) | visibility | quantity_limit.",
);
const lines = {
  onlyMatchedLines: z.boolean().optional().describe("Discount only the cart lines that came from a matching page."),
  rejectUnmatchedLines: z.boolean().optional().describe("Reject the offer when any line did not come from a matching page."),
};
const strings = (describe: string, max = 100) => z.array(z.string().trim().min(1).max(255)).max(max).describe(describe);
const money = (describe: string) => z.number().nonnegative().describe(`${describe} In major units of the shop currency (50 = 50.00).`);
const stampScope = z.enum(["page", "visit"]).optional().describe("page = seen on the current page, visit = anywhere in the visit.");

export const AuthoringConditionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cart_value"),
    scope,
    threshold: money("Minimum cart value."),
    currencyCode: z.string().length(3).optional(),
    includeGiftValues: z.boolean().optional().describe("Count the value of gifts toward the threshold."),
  }),
  z.strictObject({
    type: z.literal("cart_quantity"),
    scope,
    minQuantity: z.number().int().min(1).describe("Minimum number of items in the cart."),
    maxQuantity: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("cart_value_multiplier"),
    scope,
    threshold: money("Spend that earns one multiple of the gifts."),
    maxMultiplier: z.number().int().min(1).optional(),
    currencyCode: z.string().length(3).optional(),
  }),
  z.strictObject({
    type: z.literal("customer_tags"),
    scope,
    includeTags: strings("Customer must have one of these tags, e.g. [\"VIP\"].").optional(),
    excludeTags: strings("Customer must not have any of these tags.").optional(),
    treatGuestAsNoTags: z.boolean().optional().describe("Logged-out visitors count as having no tags (use with excludeTags)."),
  }),
  ...(["order_history_total_spent", "order_history_last_order_spent", "order_history_total_orders"] as const).map((t) =>
    z.strictObject({
      type: z.literal(t),
      scope,
      value: z.number().nonnegative().describe(t === "order_history_total_orders" ? "Number of orders." : "Amount in major units of the shop currency."),
      operator: z.enum(["eq", "gt", "gte", "lt", "lte"]).optional().describe("Default gte."),
    }),
  ),
  z.strictObject({ type: z.literal("one_use_per_customer"), scope }),
  z.strictObject({
    type: z.literal("markets"),
    scope,
    includeMarketIds: z.array(z.string().trim().min(1)).max(100).optional().describe("Shopify Market ids (numeric or GID); see markets_list."),
    excludeMarketIds: z.array(z.string().trim().min(1)).max(100).optional(),
  }),
  z.strictObject({
    type: z.literal("customer_location"),
    scope,
    includeCountryCodes: z.array(z.string().length(2)).max(250).optional().describe("Two-letter country codes, e.g. [\"US\",\"CA\"]."),
    excludeCountryCodes: z.array(z.string().length(2)).max(250).optional(),
  }),
  z.strictObject({
    type: z.literal("sales_channels"),
    scope,
    channels: z.array(z.enum(["online_store", "mobile_app", "pos"])).min(1),
  }),
  z.strictObject({ type: z.literal("subscription_product_type"), scope, mode: z.enum(["any", "subscription_only", "one_time_only"]).optional() }),
  z.strictObject({
    type: z.literal("specific_link"),
    scope,
    requiredUrl: z.string().trim().max(500).describe("Visitor must have arrived through this URL (may be empty when paramName is set)."),
    paramName: z.string().trim().max(100).optional(),
    paramValue: z.string().max(255).optional(),
    ...lines,
  }),
  z.strictObject({
    type: z.literal("page_types"),
    scope,
    pageTypes: z.array(z.enum(PAGE_TYPES)).min(1).describe("Store pages the product was added from, e.g. [\"product\",\"collection\"]."),
    pageUrls: z.array(z.string().trim().max(300)).max(50).optional().describe("Specific page paths; only used when pageTypes includes \"page\"."),
    excludeUrls: z.array(z.string().trim().max(300)).max(100).optional().describe("Paths where the offer never applies."),
    ...lines,
  }),
  z.strictObject({
    type: z.literal("template"),
    scope,
    templates: strings("Theme template names the visitor saw, e.g. [\"product.bundle\"]."),
    visitScope: stampScope,
    ...lines,
  }),
  z.strictObject({
    type: z.literal("section_shown"),
    scope,
    sections: z.array(z.strictObject({ template: z.string().trim().min(1), key: z.string().trim().min(1), label: z.string().trim().optional() })).min(1).max(50),
    visitScope: stampScope,
    ...lines,
  }),
  z.strictObject({
    type: z.literal("experiment"),
    scope,
    experimentId: z.string().trim().min(1),
    variantKeys: strings("Arms of the experiment that qualify."),
    experimentName: z.string().trim().optional(),
    variantLabels: z.record(z.string(), z.string()).optional(),
    visitScope: stampScope,
    ...lines,
  }),
  z.strictObject({
    type: z.literal("page_url"),
    scope,
    patterns: strings("URL patterns, e.g. [\"/collections/summer\"].", 50).min(1),
    matchMode: z.enum(["exact", "contains", "starts_with", "ends_with"]).optional().describe("Default starts_with."),
    ...lines,
  }),
  z.strictObject({
    type: z.literal("specific_product"),
    scope,
    matchBy: z.enum(["product", "variant"]).optional().describe("product = any variant of the product, variant = exact variants (default)."),
    ids: z.array(z.string().trim().min(1)).min(1).max(100).describe("Product or variant ids (numeric or GID), matching matchBy."),
    matchRule: z.enum(["any", "all"]).optional().describe("any = one of them is enough, all = every one needed (default)."),
    minQuantityPerProduct: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("pack_of_products"),
    scope,
    matchBy: z.enum(["product", "variant"]).optional(),
    ids: z.array(z.string().trim().min(1)).min(1).max(100),
    minQuantityPerProduct: z.number().int().min(1).optional().describe("Units of each product per pack."),
  }),
  z.strictObject({
    type: z.literal("line_attribute"),
    scope,
    key: z.enum(LINE_ATTRIBUTE_KEYS as unknown as [string, ...string[]]),
    value: z.string().trim().min(1).max(255),
    matchMode: z.enum(["equals", "not_equals"]).optional(),
    minMatchingQuantity: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("cart_attribute"),
    scope,
    key: z.enum(CART_ATTRIBUTE_KEYS as unknown as [string, ...string[]]),
    value: z.string().trim().max(255).optional(),
    matchMode: z.enum(["equals", "not_equals", "exists"]).optional(),
  }),
  z.strictObject({
    type: z.literal("utm_parameters"),
    scope,
    utmSource: z.string().trim().max(255).optional(),
    utmMedium: z.string().trim().max(255).optional(),
    utmCampaign: z.string().trim().max(255).optional(),
    utmTerm: z.string().trim().max(255).optional(),
    utmContent: z.string().trim().max(255).optional(),
    visitScope: stampScope,
    ...lines,
  }),
]);

export type AuthoringCondition = z.infer<typeof AuthoringConditionSchema>;

/** Conditions the UI places under "extra gates" by default; everything else is a main condition. */
const SUB_TYPES = new Set<string>([
  "customer_tags",
  "order_history_total_spent",
  "order_history_last_order_spent",
  "order_history_total_orders",
  "one_use_per_customer",
  "markets",
  "customer_location",
  "sales_channels",
  "subscription_product_type",
  "specific_link",
  "utm_parameters",
]);

export const defaultScopeFor = (conditionType: string): ConditionScope => (SUB_TYPES.has(conditionType) ? "sub" : "main");

/** Authoring condition -> the service's typed input (ids normalised, stamp-scope renamed back to `scope`). */
export function toConditionInput(condition: AuthoringCondition): ConditionInput {
  const { scope: _conditionScope, visitScope, ...fields } = condition as Record<string, unknown> & { visitScope?: "page" | "visit" };
  const out: Record<string, unknown> = { ...fields, ...(visitScope ? { scope: visitScope } : {}) };
  if (condition.type === "markets") {
    out["includeMarketIds"] = condition.includeMarketIds?.map(gid("Market"));
    out["excludeMarketIds"] = condition.excludeMarketIds?.map(gid("Market"));
  }
  if (condition.type === "specific_product" || condition.type === "pack_of_products") {
    out["ids"] = condition.ids.map(gid(condition.matchBy === "product" ? "Product" : "ProductVariant"));
  }
  return out as ConditionInput;
}

export const toStoredConditions: ToStored<AuthoringCondition[], StoredCondition[]> = async (input, deps) => {
  const stored: StoredCondition[] = [];
  for (const [index, condition] of input.entries()) {
    const built = buildConditionValue(condition.type, toConditionInput(condition), deps);
    if (!built.ok) return { ok: false, error: built.error, path: `conditions[${index}]` };
    stored.push({
      scope: condition.scope ?? defaultScopeFor(condition.type),
      conditionType: condition.type,
      operator: built.value.operator,
      value: built.value.value,
      sortOrder: index,
      isEnabled: true,
    });
  }
  return { ok: true, value: stored };
};
