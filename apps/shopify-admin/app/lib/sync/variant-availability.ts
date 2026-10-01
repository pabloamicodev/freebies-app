interface WebhookVariantStock {
  inventory_quantity: number | null;
  inventory_policy?: string | null;
  inventory_management?: string | null;
  available?: boolean;
}

/** products/* payloads omit `available` and, on current API versions, `inventory_management` —
 * a missing value must never read as "untracked" (that cached sold-out variants as in stock).
 * Only an explicit null means untracked. The Admin API refresh that follows is authoritative. */
export function deriveWebhookAvailability(variant: WebhookVariantStock): {
  availableForSale: boolean;
  inventoryTracked: boolean | null;
} {
  const inventoryTracked =
    variant.inventory_management === undefined ? null : variant.inventory_management !== null;
  return {
    availableForSale:
      variant.available ??
      ((variant.inventory_policy ?? "deny").toLowerCase() === "continue" ||
        (variant.inventory_quantity ?? 0) > 0 ||
        variant.inventory_management === null),
    inventoryTracked,
  };
}

/** A payload older than what the cache already holds (e.g. a product webhook arriving after a
 * fresher Admin API read triggered by an inventory webhook) must not overwrite it. */
export function isStaleProductPayload(payloadUpdatedAt: string | undefined, latestSyncedAt: Date | null): boolean {
  if (!payloadUpdatedAt || !latestSyncedAt) return false;
  const updated = Date.parse(payloadUpdatedAt);
  return Number.isFinite(updated) && updated < latestSyncedAt.getTime();
}
