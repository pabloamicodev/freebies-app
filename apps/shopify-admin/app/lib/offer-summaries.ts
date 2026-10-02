/** One-line human-readable summaries for offer conditions and reward targets.
 * Shared by the conditions/rewards editors and the offers-list row preview
 * so all three describe a given condition/reward the same way. */

import { pageTypeLabel } from "./page-types.js";
import { fromStoredAmount } from "./money.js";

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
    case "utm_parameters": {
      const fields: Array<[string, unknown]> = [
        ["utm_source", v["utmSource"]],
        ["utm_medium", v["utmMedium"]],
        ["utm_campaign", v["utmCampaign"]],
        ["utm_term", v["utmTerm"]],
        ["utm_content", v["utmContent"]],
      ];
      const set = fields.filter(([, value]) => typeof value === "string" && value.length > 0);
      const summary = set.length ? set.map(([key, value]) => `${key}=${value}`).join(", ") : "no UTM parameters set";
      return `${v["scope"] === "visit" ? `${summary} (this visit)` : summary}${v["rejectUnmatchedLines"] === true ? " · other pages block it" : ""}`;
    }
    case "page_types": {
      const types = Array.isArray(v["pageTypes"]) ? v["pageTypes"] as string[] : [];
      const summary = types.length ? `added from ${types.map(pageTypeLabel).join(", ")}` : "no page types set";
      return v["rejectUnmatchedLines"] === true ? `${summary} · other pages block it` : summary;
    }
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

/** A short customer-facing headline for a reward, e.g. "20% off", "Free gift",
 * "$10 off". `value.amount` is a raw percentage for discountType "percentage",
 * cents for every other discount type (matches how compile-config.ts and the
 * add/update_reward actions store it). Used as the row-preview's title. */
export function rewardHeadline(reward: { rewardType: string; discountType: string; value: unknown }): string {
  const v = (reward.value ?? {}) as Record<string, unknown>;
  const amount = typeof v["amount"] === "number" ? v["amount"] : 0;
  const currency = typeof v["currencyCode"] === "string" ? v["currencyCode"] : "USD";

  if (reward.discountType === "cheapest_item_free") return "Cheapest item free";
  if (reward.discountType === "free") {
    if (reward.rewardType === "shipping_discount") return "Free shipping";
    if (reward.rewardType === "product_gift") return "Free gift";
    return "Free (100% off)";
  }
  if (reward.discountType === "percentage") return `${amount}% off`;
  if (reward.discountType === "most_expensive_item_discount") return `${amount}% off most expensive item`;
  if (reward.discountType === "fixed_price") return `Fixed price ${currency} ${fromStoredAmount(amount, currency).toFixed(2)}`;
  if (reward.discountType === "fixed_amount") {
    // Shipping rewards store this raw (dollars), not in cents like every
    // other reward type — see the shipping vs. generic value-building
    // branches in app.offers.$id.rewards.tsx's action.
    const dollars = reward.rewardType === "shipping_discount" ? amount : fromStoredAmount(amount, currency);
    return `${currency} ${dollars.toFixed(2)} off`;
  }
  return reward.discountType;
}
