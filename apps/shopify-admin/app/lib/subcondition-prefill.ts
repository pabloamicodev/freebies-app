import type { SubconditionId } from "../components/subconditions/types.js";

/* Sub-condition rows (scope="sub") → subcondition-picker form state.
 * Reverses normalizeOfferSubconditions() so existing sub-conditions reopen
 * pre-filled instead of forcing the merchant to reconfigure them. Most forms
 * already read the same canonical field names the DB stores, so this is
 * mostly a conditionType → SubconditionId relabel; "quantity_limit" is the
 * one type whose stored shape (cart_quantity/specific_product rows) doesn't
 * map cleanly back to the picker's `rules` array, so it's left to the
 * merchant to reconfigure if already present. */
export function subconditionsFromRows(
  rows: Array<{ conditionType: string; value: Record<string, unknown> }>,
): { activeSubs: SubconditionId[]; subValues: Record<string, unknown> } {
  const activeSubs: SubconditionId[] = [];
  const subValues: Record<string, unknown> = {};

  for (const row of rows) {
    const v = row.value;
    switch (row.conditionType) {
      case "specific_link":
        activeSubs.push("link");
        subValues["link"] = v;
        break;
      case "customer_tags":
        activeSubs.push("customer_tags");
        subValues["customer_tags"] = v;
        break;
      case "customer_location":
        activeSubs.push("location");
        subValues["location"] = v;
        break;
      case "subscription_product_type":
        activeSubs.push("subscription");
        subValues["subscription"] = v;
        break;
      case "sales_channels":
        activeSubs.push("sales_channel");
        subValues["sales_channel"] = v;
        break;
      case "utm_parameters":
        activeSubs.push("utm_parameters");
        subValues["utm_parameters"] = v;
        break;
      case "page_types":
        activeSubs.push("page_types");
        subValues["page_types"] = v;
        break;
      case "markets":
        activeSubs.push("markets");
        subValues["markets"] = v;
        break;
      case "cart_attribute":
        activeSubs.push("custom_attribute");
        subValues["custom_attribute"] = { ...v, scope: "cart" };
        break;
      case "line_attribute":
        activeSubs.push("custom_attribute");
        subValues["custom_attribute"] = { ...v, scope: "line" };
        break;
      case "one_use_per_customer":
        activeSubs.push("order_history");
        subValues["order_history"] = { metric: "one_use_per_customer" };
        break;
      case "order_history_total_spent":
      case "order_history_last_order_spent":
      case "order_history_total_orders": {
        activeSubs.push("order_history");
        const metric = row.conditionType === "order_history_total_orders"
          ? "total_orders"
          : row.conditionType === "order_history_last_order_spent"
            ? "last_order_spent"
            : "total_spent";
        const threshold = metric === "total_orders"
          ? Number(v["value"] ?? 0)
          : Number(v["valueCents"] ?? 0) / 100;
        subValues["order_history"] = { metric, operator: v["operator"] ?? "gte", threshold };
        break;
      }
      case "cart_quantity":
      case "specific_product":
        // Sub-scope quantity limits: mark as active so the card shows up,
        // but leave the value for the merchant to re-enter (see doc comment).
        if (!activeSubs.includes("quantity_limit")) activeSubs.push("quantity_limit");
        break;
      default:
        break;
    }
  }

  return { activeSubs, subValues };
}
