// Line attributes reach the Function through the metadata bridge's packed property;
// only cart attributes need query-variable slots (Shopify caps query complexity at 30).
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
): string[] {
  return [...new Set(conditions
    .filter((condition) => condition.conditionType === conditionType)
    .flatMap((condition) => conditionKey(condition) ?? []))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildAttributeQueryVariables(conditions: AttributeCondition[]): Record<string, string> {
  const cartKeys = customKeys(conditions, "cart_attribute");

  if (cartKeys.length > MAX_CUSTOM_CART_ATTRIBUTE_KEYS) {
    throw new Error(`Active offers use ${cartKeys.length} custom cart attribute keys; this app currently supports up to ${MAX_CUSTOM_CART_ATTRIBUTE_KEYS} active keys per store within Shopify's Function query-size limit.`);
  }

  return {
    ...Object.fromEntries(cartKeys.map((key, index) => [`c${index + 1}`, key])),
  };
}
