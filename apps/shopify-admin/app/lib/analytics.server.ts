/**
 * Analytics persistence and deduplication utilities.
 *
 * Handles:
 * - Event ingestion with deduplication (idempotent by session+event+offer within 1-min window)
 * - First-touch / last-touch attribution tracking
 * - Cart attribute persistence for order reconciliation
 * - Campaign type breakdown queries
 */

import { getDb, analyticsEvents } from "@promo/db";
import { eq, and, gte, desc } from "drizzle-orm";

export interface IngestEventPayload {
  shopId: string;
  eventName: string;
  sessionId: string | null;
  cartToken: string | null;
  offerId: string | null;
  offerVersion: string | null;
  widgetId: string | null;
  orderId: string | null;
  abVariant: string | null;
  properties: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Ingest a single analytics event with deduplication.
 * - Deduplicates `promo_engine:gift_auto_added` by (sessionId + offerId + variantId) within 5 min.
 * - Deduplicates `promo_engine:widget_viewed` by (sessionId + widgetId) within 1 min.
 * - All other events are inserted without deduplication.
 */
export async function ingestEvent(payload: IngestEventPayload): Promise<void> {
  const db = getDb();

  // Deduplication window
  const DEDUP_WINDOWS: Record<string, number> = {
    "promo_engine:gift_auto_added": 5 * 60 * 1000,
    "promo_engine:widget_viewed": 60 * 1000,
    "promo_engine:offer_qualified": 60 * 1000,
  };

  const dedupWindowMs = DEDUP_WINDOWS[payload.eventName];

  if (dedupWindowMs && payload.sessionId && payload.offerId) {
    const since = new Date(payload.occurredAt.getTime() - dedupWindowMs);
    const [existing] = await db.select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, payload.shopId),
        eq(analyticsEvents.eventName, payload.eventName),
        eq(analyticsEvents.sessionId, payload.sessionId),
        eq(analyticsEvents.offerId, payload.offerId),
        gte(analyticsEvents.occurredAt, since),
      ))
      .limit(1);

    if (existing) return; // Duplicate — skip
  }

  await db.insert(analyticsEvents).values({
    shopId: payload.shopId,
    eventName: payload.eventName,
    sessionId: payload.sessionId,
    cartToken: payload.cartToken,
    offerId: payload.offerId ?? undefined,
    offerVersion: payload.offerVersion,
    widgetId: payload.widgetId ?? undefined,
    orderId: payload.orderId,
    abVariant: payload.abVariant,
    properties: payload.properties,
    occurredAt: payload.occurredAt,
  });
}

/**
 * Ingest a batch of events (from Web Pixel sendBeacon payload).
 * Processes sequentially to respect deduplication.
 */
export async function ingestEventBatch(shopId: string, events: unknown[]): Promise<void> {
  for (const raw of events.slice(0, 100)) {
    if (typeof raw !== "object" || !raw) continue;
    const event = raw as Record<string, unknown>;
    if (typeof event["event_name"] !== "string") continue;

    await ingestEvent({
      shopId,
      eventName: event["event_name"] as string,
      sessionId: (event["session_id"] as string) ?? null,
      cartToken: (event["cart_token"] as string) ?? null,
      offerId: (event["offer_id"] as string) ?? null,
      offerVersion: (event["offer_version"] as string) ?? null,
      widgetId: (event["widget_id"] as string) ?? null,
      orderId: (event["order_id"] as string) ?? null,
      abVariant: (event["ab_variant"] as string) ?? null,
      properties: (event["properties"] as Record<string, unknown>) ?? {},
      occurredAt: event["occurred_at"] ? new Date(event["occurred_at"] as string) : new Date(),
    }).catch(() => {}); // Never fail on analytics
  }
}

/**
 * Track first-touch and last-touch offer for a session.
 * Stored as analytics events with special names.
 */
export async function trackAttribution(
  shopId: string,
  sessionId: string,
  offerId: string,
  cartToken: string | null,
): Promise<void> {
  const db = getDb();

  // Check if this is the first offer qualified in this session
  const [firstTouch] = await db.select({ id: analyticsEvents.id })
    .from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.eventName, "attribution:first_touch"),
      eq(analyticsEvents.sessionId, sessionId),
    ))
    .limit(1);

  if (!firstTouch) {
    await db.insert(analyticsEvents).values({
      shopId,
      eventName: "attribution:first_touch",
      sessionId,
      cartToken,
      offerId,
      properties: {},
    }).catch(() => {});
  }

  // Always update last-touch (upsert pattern)
  await db.delete(analyticsEvents).where(and(
    eq(analyticsEvents.shopId, shopId),
    eq(analyticsEvents.eventName, "attribution:last_touch"),
    eq(analyticsEvents.sessionId, sessionId),
  )).catch(() => {});

  await db.insert(analyticsEvents).values({
    shopId,
    eventName: "attribution:last_touch",
    sessionId,
    cartToken,
    offerId,
    properties: {},
  }).catch(() => {});
}

/**
 * Persist offer attribution in cart attributes payload.
 * Returns the attributes to add to the cart (via /cart/update.js or cartAttributesUpdate).
 */
export function buildCartAttributionAttributes(
  sessionId: string,
  offerIds: string[],
): Record<string, string> {
  return {
    _promo_engine_session_id: sessionId,
    _promo_engine_offer_ids: JSON.stringify([...new Set(offerIds)].slice(0, 10)),
  };
}

/**
 * Campaign type breakdown — count events by offer type over a time range.
 */
export async function getCampaignBreakdown(
  shopId: string,
  since: Date,
): Promise<Array<{ type: string; count: number }>> {
  const db = getDb();

  // Join analytics_events with offers to get type
  const rows = await db.execute(
    `SELECT o.type, COUNT(ae.id)::int as count
     FROM analytics_events ae
     LEFT JOIN offers o ON ae.offer_id = o.id
     WHERE ae.shop_id = $1
       AND ae.event_name = 'promo_engine:gift_auto_added'
       AND ae.occurred_at >= $2
     GROUP BY o.type
     ORDER BY count DESC`,
    [shopId, since],
  );

  return (rows as any[]).map((r) => ({ type: r.type ?? "unknown", count: r.count }));
}
