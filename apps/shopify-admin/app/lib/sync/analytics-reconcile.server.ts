import { getDb, analyticsEvents, type Db } from "@promo/db";
import { inArray, lt } from "drizzle-orm";

const CLEANUP_BATCH_SIZE = 5_000;

export interface ReconcileOrderData {
  shopId: string;
  orderId: string;
  orderGid: string;
  cartToken: string | null;
  customerId: string | null;
  totalPriceCents: number;
  offerIds: string[];
  sessionId: string | null;
}

export async function reconcileOrderAttribution(data: ReconcileOrderData): Promise<void> {
  const { shopId, orderId, orderGid, cartToken, customerId, totalPriceCents, offerIds, sessionId } = data;

  if (offerIds.length === 0) return;

  const db = getDb();

  for (const offerId of offerIds) {
    await db.insert(analyticsEvents).values({
      shopId,
      eventName: "order_placed_attributed",
      sessionId: sessionId ?? cartToken,
      cartToken,
      customerId,
      orderId: orderGid,
      deduplicationKey: `shopify:${shopId}:order-paid:${orderGid}:${offerId}`,
      offerId: offerId.length === 36 ? offerId : null,
      properties: {
        order_id: orderId,
        total_price_cents: totalPriceCents,
        offer_ids: offerIds,
        subtotalCents: totalPriceCents,
      },
    }).onConflictDoNothing({ target: analyticsEvents.deduplicationKey });
  }
}

export async function cleanupOldAnalyticsEvents(retentionDays = 90, db: Db = getDb()): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // A single unbounded DELETE ... RETURNING here could try to delete and hand
  // back millions of rows/ids after being off for a while — batch it instead,
  // deleting by id so no batch ever RETURNINGs more than CLEANUP_BATCH_SIZE.
  let totalDeleted = 0;
  for (;;) {
    const batch = await db
      .select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(lt(analyticsEvents.occurredAt, cutoff))
      .limit(CLEANUP_BATCH_SIZE);
    if (batch.length === 0) break;
    await db.delete(analyticsEvents).where(inArray(analyticsEvents.id, batch.map((row) => row.id)));
    totalDeleted += batch.length;
    if (batch.length < CLEANUP_BATCH_SIZE) break;
  }
  return totalDeleted;
}
