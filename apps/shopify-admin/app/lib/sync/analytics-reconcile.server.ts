import { getDb, analyticsEvents } from "@promo/db";
import { lt } from "drizzle-orm";

export interface ReconcileOrderData {
  shopId: string;
  orderId: string;
  orderGid: string;
  cartToken: string | null;
  totalPriceCents: number;
  offerIds: string[];
  sessionId: string | null;
}

export async function reconcileOrderAttribution(data: ReconcileOrderData): Promise<void> {
  const { shopId, orderId, orderGid, cartToken, totalPriceCents, offerIds, sessionId } = data;

  const identifiers = [cartToken, sessionId].filter(Boolean);
  if (identifiers.length === 0 || offerIds.length === 0) return;

  const db = getDb();

  for (const offerId of offerIds) {
    await db.insert(analyticsEvents).values({
      shopId,
      eventName: "order_placed_attributed",
      sessionId: sessionId ?? cartToken,
      cartToken,
      orderId: orderGid,
      offerId: offerId.length === 36 ? offerId : null,
      properties: {
        order_id: orderId,
        total_price_cents: totalPriceCents,
        offer_ids: offerIds,
      },
    }).onConflictDoNothing();
  }
}

export async function cleanupOldAnalyticsEvents(retentionDays = 90): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(analyticsEvents).where(lt(analyticsEvents.occurredAt, cutoff)).returning({ id: analyticsEvents.id });
  return deleted.length;
}
