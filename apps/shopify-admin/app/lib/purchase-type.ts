export type SubscriptionMode = "any" | "subscription_only" | "one_time_only";

export function normalizeSubscriptionMode(value: unknown): SubscriptionMode {
  return value === "subscription_only" || value === "one_time_only" ? value : "any";
}

export function parseSubscriptionMode(formData: FormData): SubscriptionMode {
  return normalizeSubscriptionMode(formData.get("subscriptionMode"));
}

export function purchaseTypesToMode(oneTime: boolean, subscription: boolean): SubscriptionMode {
  if (oneTime && !subscription) return "one_time_only";
  if (subscription && !oneTime) return "subscription_only";
  return "any";
}

export function purchaseTypeLabel(mode: unknown): string {
  const normalized = normalizeSubscriptionMode(mode);
  if (normalized === "subscription_only") return "Subscriptions only";
  if (normalized === "one_time_only") return "One-time purchases only";
  return "One-time + subscriptions";
}

/** Reward target with the purchase type applied: "any" stays implicit so existing configs are unchanged. */
export function withSubscriptionMode<T extends Record<string, unknown>>(target: T, mode: SubscriptionMode): T {
  const { subscriptionMode: _ignored, ...rest } = target;
  return (mode === "any" ? rest : { ...rest, subscriptionMode: mode }) as T;
}
