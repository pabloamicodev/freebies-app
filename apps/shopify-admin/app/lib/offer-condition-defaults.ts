import type { SubconditionId } from "../components/subconditions/types.js";

const DEFAULT_VALUES: Record<SubconditionId, Record<string, unknown>> = {
  link: { requiredUrl: "", paramName: "freegifts_code", paramValue: "" },
  order_history: { metric: "total_spent", operator: "gte", threshold: 0 },
  customer_tags: { includeTags: [], excludeTags: [], treatGuestAsNoTags: true },
  location: { includeCountryCodes: [], excludeCountryCodes: [] },
  subscription: { mode: "subscription_only" },
  sales_channel: { channels: ["online_store"] },
  markets: { includeMarketIds: [], excludeMarketIds: [] },
  custom_attribute: {
    scope: "line",
    key: "",
    value: "",
    matchMode: "equals",
    minMatchingQuantity: 1,
  },
  quantity_limit: {
    matchMode: "all",
    rules: [{ qty: 1, scope: "specific_products", operator: "at_least", productIds: [] }],
  },
};

export function initializeOfferConditionValues(
  active: SubconditionId[],
  current: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    active.map((id) => [id, current[id] ?? structuredClone(DEFAULT_VALUES[id])]),
  );
}
