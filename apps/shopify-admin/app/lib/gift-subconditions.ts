import { validateConditionValue, type ConditionOperator, type ConditionType } from "@promo/shared-types";

export interface NormalizedGiftSubcondition {
  conditionType: ConditionType;
  operator: ConditionOperator;
  value: Record<string, unknown>;
}

type NormalizeResult =
  | { success: true; data: NormalizedGiftSubcondition[] }
  | { success: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function csv(value: unknown, uppercase = false): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [uppercase ? item.toUpperCase() : item] : []);
  return String(value ?? "").split(",").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [uppercase ? trimmed.toUpperCase() : trimmed] : [];
  });
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeGiftSubconditions(input: Record<string, unknown>): NormalizeResult {
  const conditions: NormalizedGiftSubcondition[] = [];

  for (const [id, raw] of Object.entries(input)) {
    const value = record(raw);
    if (!value || Object.keys(value).length === 0) continue;

    switch (id) {
      case "link":
        conditions.push({
          conditionType: "specific_link",
          operator: "eq",
          value: {
            requiredUrl: String(value["requiredUrl"] ?? "").trim(),
            ...(String(value["paramName"] ?? "").trim() ? { paramName: String(value["paramName"]).trim() } : {}),
            ...(value["paramValue"] === undefined || String(value["paramValue"]).length === 0 ? {} : { paramValue: String(value["paramValue"]) }),
          },
        });
        break;
      case "order_history": {
        const metric = String(value["metric"] ?? "total_spent");
        if (metric === "one_use_per_customer") {
          conditions.push({ conditionType: "one_use_per_customer", operator: "eq", value: {} });
          break;
        }
        const threshold = Number(value["threshold"] ?? 0);
        if (!Number.isFinite(threshold) || threshold < 0) return { success: false, error: "Order history threshold must be zero or greater." };
        const conditionType = metric === "last_order_spent"
          ? "order_history_last_order_spent"
          : metric === "total_orders"
            ? "order_history_total_orders"
            : "order_history_total_spent";
        const operator = ["eq", "gt", "gte", "lt", "lte"].includes(String(value["operator"]))
          ? String(value["operator"]) as ConditionOperator
          : "gte";
        conditions.push({
          conditionType,
          operator,
          value: {
            type: metric,
            operator,
            ...(metric === "total_orders" ? { value: Math.floor(threshold) } : { valueCents: Math.round(threshold * 100) }),
          },
        });
        break;
      }
      case "customer_tags": {
        const tags = csv(value["tags"]);
        if (tags.length === 0) return { success: false, error: "Enter at least one customer tag." };
        conditions.push({
          conditionType: "customer_tags",
          operator: "eq",
          value: {
            includeTags: value["exclude"] ? [] : tags,
            excludeTags: value["exclude"] ? tags : [],
            treatGuestAsNoTags: value["guest"] !== false,
          },
        });
        break;
      }
      case "location": {
        const countries = csv(value["countries"], true);
        if (countries.length === 0) return { success: false, error: "Enter at least one two-letter country code." };
        conditions.push({
          conditionType: "customer_location",
          operator: "eq",
          value: {
            includeCountryCodes: value["exclude"] ? [] : countries,
            excludeCountryCodes: value["exclude"] ? countries : [],
          },
        });
        break;
      }
      case "subscription":
        conditions.push({
          conditionType: "subscription_product_type",
          operator: "eq",
          value: { mode: value["mode"] === "one_time" ? "one_time_only" : "subscription_only" },
        });
        break;
      case "sales_channel": {
        const channels = [
          value["online"] ? "online_store" : null,
          value["mobile"] ? "mobile_app" : null,
          value["pos"] ? "pos" : null,
        ].filter((channel): channel is string => Boolean(channel));
        conditions.push({ conditionType: "sales_channels", operator: "eq", value: { channels } });
        break;
      }
      case "markets": {
        const marketIds = csv(value["marketIds"]);
        if (marketIds.length === 0) return { success: false, error: "Select at least one Shopify Market." };
        conditions.push({
          conditionType: "markets",
          operator: "eq",
          value: {
            includeMarketIds: value["exclude"] ? [] : marketIds,
            excludeMarketIds: value["exclude"] ? marketIds : [],
          },
        });
        break;
      }
      case "custom_attribute": {
        const scope = value["scope"] === "cart" ? "cart" : "line";
        conditions.push({
          conditionType: scope === "cart" ? "cart_attribute" : "line_attribute",
          operator: "eq",
          value: {
            key: String(value["key"] ?? "").trim(),
            value: String(value["value"] ?? ""),
            matchMode: value["matchMode"] === "not_equals" ? "not_equals" : "equals",
            ...(scope === "line" ? { minMatchingQuantity: Math.max(1, Number(value["minMatchingQuantity"] ?? 1) || 1) } : {}),
          },
        });
        break;
      }
      case "quantity_limit": {
        if (value["matchMode"] === "any") {
          return { success: false, error: "Quantity limits currently require ‘All rules’ so checkout enforcement can match storefront evaluation." };
        }
        const rawRules = value["rules"];
        const rules: Record<string, unknown>[] = Array.isArray(rawRules)
          ? rawRules.flatMap((item): Record<string, unknown>[] => {
              const parsed = record(item);
              return parsed ? [parsed] : [];
            })
          : [];
        const requirements: Array<Record<string, unknown>> = [];
        for (const rule of rules) {
          const quantity = positiveInteger(rule["qty"]);
          if (quantity === null || quantity < 1) return { success: false, error: "Every quantity limit must be at least 1." };
          if (rule["scope"] === "any_product") {
            conditions.push({
              conditionType: "cart_quantity",
              operator: "gte",
              value: {
                minQuantity: quantity,
                ...(rule["operator"] === "exactly" ? { maxQuantity: quantity } : {}),
                includeGiftValues: false,
              },
            });
            continue;
          }
          const ids = csv(rule["productIds"]);
          if (ids.length === 0) return { success: false, error: "Select at least one product for every product quantity rule." };
          for (const id of ids) {
            const isVariant = id.includes("/ProductVariant/");
            requirements.push({
              ...(isVariant ? { variantId: id } : { productId: id }),
              trackMode: isVariant ? "variant" : "product",
              minQuantity: quantity,
              ...(rule["operator"] === "exactly" ? { maxQuantity: quantity } : {}),
            });
          }
        }
        if (requirements.length > 0) {
          conditions.push({ conditionType: "specific_product", operator: "gte", value: { requirements, multiplyByGroups: false } });
        }
        break;
      }
    }
  }

  for (const condition of conditions) {
    const parsed = validateConditionValue(condition.conditionType, condition.value);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? `Invalid ${condition.conditionType} condition.` };
    }
  }

  return { success: true, data: conditions };
}
