import { AsyncLocalStorage } from "node:async_hooks";
import { capacityIncidents, getDb, offers, shops, type Db, type HeldOffer } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { isCapacityModalCode, type CapacityModalData } from "./capacity-modal-copy.js";
import { incidentDedupeKey } from "./capacity-incidents.server.js";
import { runWithCapacitySource } from "./capacity-source.server.js";

export interface CapturedCapacity {
  shopId: string;
  code: string;
  offerIds: string[];
  numbers: Record<string, number>;
  /** OFFER_TOO_LARGE with sharding on: why the offer cannot be split across Shopify discounts. */
  splitRefusal?: string;
  /** Offers the blocked publish was switching on, as they stood at the block (persisted on the incident only). */
  held?: HeldOffer[];
}

const store = new AsyncLocalStorage<{ captured?: CapturedCapacity }>();

/** Called where a Shopify capacity limit blocks a publish; a no-op outside `withCapacityModal`. */
export function recordCapacityBlock(captured: CapturedCapacity): void {
  const scope = store.getStore();
  if (scope) scope.captured = captured;
}

export async function buildCapacityModalData(db: Db, captured: CapturedCapacity): Promise<CapacityModalData | null> {
  if (!isCapacityModalCode(captured.code)) return null;
  const [rows, [shop]] = await Promise.all([
    captured.offerIds.length > 0
      ? db
          .select({ id: offers.id, name: offers.internalName })
          .from(offers)
          .where(and(eq(offers.shopId, captured.shopId), inArray(offers.id, captured.offerIds)))
      : Promise.resolve([] as { id: string; name: string }[]),
    db.select({ domain: shops.myshopifyDomain }).from(shops).where(eq(shops.id, captured.shopId)).limit(1),
  ]);
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  const [incident] = await db
    .select({ id: capacityIncidents.id })
    .from(capacityIncidents)
    .where(and(eq(capacityIncidents.shopId, captured.shopId), eq(capacityIncidents.dedupeKey, incidentDedupeKey(captured)), inArray(capacityIncidents.status, ["open", "dismissed"])))
    .limit(1);
  return {
    code: captured.code,
    offers: captured.offerIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
    numbers: captured.numbers,
    ...(captured.splitRefusal ? { splitRefusal: captured.splitRefusal } : {}),
    ...(shop ? { discountsUrl: `https://${shop.domain}/admin/discounts` } : {}),
    ...(incident ? { incidentId: incident.id } : {}),
  };
}

/**
 * Wraps a route action: when it returns `{ error }` after a Shopify capacity limit blocked the publish, the
 * result also carries `capacity` so the page opens the Shopify-limit modal. Other results pass through.
 */
export function withCapacityModal<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result & { capacity?: CapacityModalData }> {
  return async (...args) => {
    const scope: { captured?: CapturedCapacity } = {};
    const result = await store.run(scope, () => runWithCapacitySource("admin", true, () => action(...args)));
    const plain = result as Result & { capacity?: CapacityModalData };
    if (!scope.captured || !result || typeof result !== "object" || result instanceof Response) return plain;
    if (!(result as { error?: unknown }).error) return plain;
    try {
      const capacity = await buildCapacityModalData(getDb(), scope.captured);
      return capacity ? { ...plain, capacity } : plain;
    } catch {
      return plain;
    }
  };
}
