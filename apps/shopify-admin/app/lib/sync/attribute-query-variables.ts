import { CART_ATTRIBUTE_KEYS, LINE_ATTRIBUTE_KEYS } from "@promo/shared-types";

export const MAX_CUSTOM_LINE_ATTRIBUTE_KEYS = 6;
export const MAX_CUSTOM_CART_ATTRIBUTE_KEYS = 3;

interface AttributeCondition {
  conditionType: string;
  value: unknown;
  isEnabled?: boolean;
}

function conditionKey(condition: AttributeCondition): string | null {
  if (condition.isEnabled === false || !condition.value || typeof condition.value !== "object") return null;
  const key = (condition.value as Record<string, unknown>)["key"];
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function customKeys(
  conditions: AttributeCondition[],
  conditionType: "line_attribute" | "cart_attribute",
  builtIns: readonly string[],
): string[] {
  const builtInSet = new Set(builtIns);
  return [...new Set(conditions
    .filter((condition) => condition.conditionType === conditionType)
    .flatMap((condition) => conditionKey(condition) ?? [])
    .filter((key) => !builtInSet.has(key)))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildAttributeQueryVariables(conditions: AttributeCondition[]): Record<string, string> {
  const lineKeys = customKeys(conditions, "line_attribute", LINE_ATTRIBUTE_KEYS);
  const cartKeys = customKeys(conditions, "cart_attribute", CART_ATTRIBUTE_KEYS);

  if (lineKeys.length > MAX_CUSTOM_LINE_ATTRIBUTE_KEYS) {
    throw new Error(`Active offers use ${lineKeys.length} custom line attribute keys; this app currently supports up to ${MAX_CUSTOM_LINE_ATTRIBUTE_KEYS} active keys per store within Shopify's Function query-size limit.`);
  }
  if (cartKeys.length > MAX_CUSTOM_CART_ATTRIBUTE_KEYS) {
    throw new Error(`Active offers use ${cartKeys.length} custom cart attribute keys; this app currently supports up to ${MAX_CUSTOM_CART_ATTRIBUTE_KEYS} active keys per store within Shopify's Function query-size limit.`);
  }

  return {
    ...Object.fromEntries(lineKeys.map((key, index) => [`l${index + 1}`, key])),
    ...Object.fromEntries(cartKeys.map((key, index) => [`c${index + 1}`, key])),
  };
}
