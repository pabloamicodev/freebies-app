/** One-line human-readable summaries for offer conditions and reward targets.
 * Shared by the conditions/rewards editors and the offers-list row preview
 * so all three describe a given condition/reward the same way. */

export function conditionSummary(conditionType: string, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (conditionType) {
    case "cart_value":
    case "cart_value_multiplier": {
      const amount = typeof v["thresholdCents"] === "number" ? (v["thresholdCents"] / 100).toFixed(2) : "?";
      return `≥ ${v["currencyCode"] ?? "USD"} ${amount}`;
    }
    case "cart_quantity":
      return `${v["minQuantity"] ?? "?"}${v["maxQuantity"] ? `–${v["maxQuantity"]}` : "+"} items`;
    case "customer_tags": {
      const include = Array.isArray(v["includeTags"]) ? v["includeTags"] as string[] : [];
      const exclude = Array.isArray(v["excludeTags"]) ? v["excludeTags"] as string[] : [];
      return [include.length ? `include: ${include.join(", ")}` : null, exclude.length ? `exclude: ${exclude.join(", ")}` : null].filter(Boolean).join(" · ") || "no tags set";
    }
    case "line_attribute":
    case "cart_attribute":
      return `${v["key"] ?? "?"} ${v["matchMode"] === "not_equals" ? "≠" : "="} "${v["value"] ?? ""}"`;
    case "discount_code":
      return `code: ${v["code"] ?? "?"}`;
    case "specific_product":
    case "pack_of_products": {
      const requirements = Array.isArray(v["requirements"]) ? v["requirements"] as unknown[] : [];
      return `${requirements.length} product${requirements.length === 1 ? "" : "s"} required`;
    }
    case "page_url": {
      const patterns = Array.isArray(v["patterns"]) ? v["patterns"] as string[] : [];
      return patterns.join(", ") || "no patterns set";
    }
    case "markets": {
      const include = Array.isArray(v["includeMarketIds"]) ? v["includeMarketIds"].length : 0;
      const exclude = Array.isArray(v["excludeMarketIds"]) ? v["excludeMarketIds"].length : 0;
      return `${include} included, ${exclude} excluded`;
    }
    case "customer_location": {
      const include = Array.isArray(v["includeCountryCodes"]) ? v["includeCountryCodes"] as string[] : [];
      const exclude = Array.isArray(v["excludeCountryCodes"]) ? v["excludeCountryCodes"] as string[] : [];
      return [include.length ? `include: ${include.join(", ")}` : null, exclude.length ? `exclude: ${exclude.join(", ")}` : null].filter(Boolean).join(" · ") || "no countries set";
    }
    case "sales_channels":
      return Array.isArray(v["channels"]) ? (v["channels"] as string[]).join(", ") : "";
    case "subscription_product_type":
      return String(v["mode"] ?? "");
    case "specific_link":
      return String(v["requiredUrl"] ?? "");
    case "one_use_per_customer":
      return "One redemption per customer";
    default: {
      if (typeof v["type"] === "string") {
        return `${v["type"]} ${v["operator"] ?? ""} ${v["value"] ?? (typeof v["valueCents"] === "number" ? (v["valueCents"] / 100).toFixed(2) : "")}`.trim();
      }
      return JSON.stringify(value);
    }
  }
}

export function targetSummaryParts(target: unknown): string[] {
  if (!target || typeof target !== "object") return [];
  const t = target as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(t["productIds"]) && t["productIds"].length)
    parts.push(`${t["productIds"].length} product${t["productIds"].length === 1 ? "" : "s"}`);
  if (Array.isArray(t["variantIds"]) && t["variantIds"].length)
    parts.push(`${t["variantIds"].length} variant${t["variantIds"].length === 1 ? "" : "s"}`);
  if (t["scope"] === "cart") parts.push("entire cart");
  if (typeof t["scopeMode"] === "string" && t["scopeMode"] !== "sitewide")
    parts.push(`scope: ${t["scopeMode"]}`);
  if (typeof t["lineQuantityEquals"] === "number") parts.push(`qty = ${t["lineQuantityEquals"]}`);
  if (typeof t["maxUnitsTotal"] === "number") parts.push(`max ${t["maxUnitsTotal"]} total`);
  if (typeof t["maxUnitsPerProduct"] === "number") parts.push(`max ${t["maxUnitsPerProduct"]}/product`);
  if (typeof t["maxUnitsPerLine"] === "number") parts.push(`max ${t["maxUnitsPerLine"]}/line`);
  if (typeof t["maxUnitsPerVariant"] === "number") parts.push(`max ${t["maxUnitsPerVariant"]}/variant`);
  return parts;
}

/** Every variant/product GID a reward target references, in every shape a
 * target can take (single id, array, or both). Used to batch-resolve product
 * images/titles for the offers-list row preview. */
export function collectGids(target: unknown): string[] {
  if (!target || typeof target !== "object") return [];
  const t = target as Record<string, unknown>;
  const gids: string[] = [];
  if (Array.isArray(t["variantIds"])) gids.push(...t["variantIds"].filter((id): id is string => typeof id === "string"));
  if (Array.isArray(t["productIds"])) gids.push(...t["productIds"].filter((id): id is string => typeof id === "string"));
  if (typeof t["variantId"] === "string") gids.push(t["variantId"]);
  if (typeof t["productId"] === "string") gids.push(t["productId"]);
  return gids;
}

/** The storefront URL(s) a condition depends on, if any — used to surface
 * "this offer only applies on these pages" in the row preview. */
export function urlsFromCondition(conditionType: string, value: unknown): string[] {
  const v = (value ?? {}) as Record<string, unknown>;
  if (conditionType === "page_url" && Array.isArray(v["patterns"])) {
    return v["patterns"].filter((p): p is string => typeof p === "string");
  }
  if (conditionType === "specific_link" && typeof v["requiredUrl"] === "string" && v["requiredUrl"]) {
    return [v["requiredUrl"]];
  }
  return [];
}
