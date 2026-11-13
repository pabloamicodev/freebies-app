/**
 * Read queries behind the analytics pages (index and per-offer). The route loaders and the MCP read tools both
 * call these, so the admin UI and the MCP always show the same numbers.
 */
import { analyticsEvents, offers, type Db } from "@promo/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

// "order_placed_attributed" is the event reconcileOrderAttribution actually writes (webhooks.$.tsx handleOrderPaid).
export const ORDER_EVENT_NAME = "order_placed_attributed";
const DAY_MS = 24 * 60 * 60 * 1000;

export const FUNNEL_EVENTS = [
  { event: "promo_engine:widget_viewed", label: "Widget Viewed" },
  { event: "promo_engine:offer_qualified", label: "Offer Qualified" },
  { event: "promo_engine:gift_auto_added", label: "Gift Added" },
  { event: "checkout_started", label: "Checkout Started" },
  { event: "order_placed_attributed", label: "Order Placed" },
] as const;

export interface AnalyticsOrderRow {
  id: string;
  orderId: string;
  date: string;
  giftName: string;
  totalCents: number;
}

export interface AnalyticsOverview {
  orders: AnalyticsOrderRow[];
  totalSalesCents: number;
  avgOrderCents: number;
  orderCount: number;
  salesChartData: { x: string; y: number }[];
  ordersChartData: { x: string; y: number }[];
  days: number;
}

/** `?days=` as the analytics page reads it: positive integer, capped at 365, default 7. */
export function parseAnalyticsDays(raw: string | null | undefined): number {
  const parsed = parseInt(raw ?? "7", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 7;
}

export function emptyAnalyticsOverview(days: number): AnalyticsOverview {
  return { orders: [], totalSalesCents: 0, avgOrderCents: 0, orderCount: 0, salesChartData: [], ordersChartData: [], days };
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Formats a plain 'YYYY-MM-DD' without Date/timezone parsing, so the label matches the UTC day it was grouped by. */
export function formatIsoDayLabel(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${MONTH_ABBR[(month ?? 1) - 1]} ${day}`;
}

export async function loadAnalyticsOverview(
  db: Db,
  shopId: string,
  days: number,
  now: () => Date = () => new Date(),
): Promise<AnalyticsOverview & { offerCount: number; orderEventCount: number }> {
  const nowMs = now().getTime();
  const since = new Date(nowMs - days * DAY_MS);

  const [recentOrderEvents, offerRows, dailyTotals] = await Promise.all([
    db
      .select({
        id: analyticsEvents.id,
        offerId: analyticsEvents.offerId,
        orderId: analyticsEvents.orderId,
        properties: analyticsEvents.properties,
        occurredAt: analyticsEvents.occurredAt,
      })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.shopId, shopId),
          eq(analyticsEvents.eventName, ORDER_EVENT_NAME),
          gte(analyticsEvents.occurredAt, since),
        ),
      )
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(50),
    db
      .select({ id: offers.id, internalName: offers.internalName })
      .from(offers)
      .where(eq(offers.shopId, shopId)),
    // Totals/chart come from a SQL aggregate over the whole window, not the 50-row page above: an order with
    // several attributed offers writes one row per offer, so this dedupes to one row per order before summing.
    db.execute<{ day: string; sales_cents: string | null; order_count: number }>(sql`
      WITH deduped_orders AS (
        SELECT DISTINCT ON (order_id)
          order_id,
          to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          COALESCE((properties->>'subtotalCents')::bigint, 0) AS subtotal_cents
        FROM analytics_events
        WHERE shop_id = ${shopId}
          AND event_name = ${ORDER_EVENT_NAME}
          AND occurred_at >= ${since.toISOString()}
          AND order_id IS NOT NULL
        ORDER BY order_id, occurred_at DESC
      )
      SELECT day, SUM(subtotal_cents)::bigint AS sales_cents, COUNT(*)::int AS order_count
      FROM deduped_orders
      GROUP BY day
    `),
  ]);
  const offerNames: Record<string, string> = {};
  offerRows.forEach((o) => { offerNames[o.id] = o.internalName; });

  // Pre-seed every calendar day in the window (UTC) so the chart shows zeros instead of gaps.
  const dayBuckets: Record<string, { sales: number; orders: number }> = {};
  for (let i = days - 1; i >= 0; i--) {
    const isoDay = new Date(nowMs - i * 86400000).toISOString().slice(0, 10);
    dayBuckets[isoDay] = { sales: 0, orders: 0 };
  }

  let totalSalesCents = 0;
  let orderCount = 0;
  // postgres-js returns the rows as an array; pglite (tests) wraps them in { rows }.
  const dailyRows = Array.isArray(dailyTotals) ? dailyTotals : ((dailyTotals as { rows?: typeof dailyTotals }).rows ?? []);
  for (const row of dailyRows) {
    const salesCents = Number(row.sales_cents ?? 0);
    const rowOrderCount = Number(row.order_count ?? 0);
    totalSalesCents += salesCents;
    orderCount += rowOrderCount;
    if (dayBuckets[row.day]) {
      dayBuckets[row.day]!.sales += salesCents;
      dayBuckets[row.day]!.orders += rowOrderCount;
    }
  }
  const avgOrderCents = orderCount > 0 ? Math.round(totalSalesCents / orderCount) : 0;

  const orders = recentOrderEvents.flatMap((ev) => {
    if (!ev.orderId) return [];
    const props = ev.properties as Record<string, unknown> | null;
    const subtotalCents = typeof props?.subtotalCents === "number" ? props.subtotalCents : 0;
    const giftName = ev.offerId ? (offerNames[ev.offerId] ?? "Gift Offer") : "Gift Offer";
    return [{ id: ev.id, orderId: ev.orderId, date: ev.occurredAt.toISOString(), giftName, totalCents: subtotalCents }];
  });

  return {
    orders,
    totalSalesCents,
    avgOrderCents,
    orderCount,
    salesChartData: Object.entries(dayBuckets).map(([iso, v]) => ({ x: formatIsoDayLabel(iso), y: v.sales / 100 })),
    ordersChartData: Object.entries(dayBuckets).map(([iso, v]) => ({ x: formatIsoDayLabel(iso), y: v.orders })),
    days,
    offerCount: offerRows.length,
    orderEventCount: recentOrderEvents.length,
  };
}

export interface OfferAnalytics {
  offer: { id: string; internalName: string; type: string; status: string };
  funnelData: { label: string; count: number }[];
  errorRate: string;
  totalEvents: number;
  impressions: number;
  giftAdds: number;
  addRate: string;
  recentEvents: { id: string; eventName: string; occurredAt: string }[];
}

/** Null when the offer does not belong to the shop. Funnel and error rate cover the last 30 days. */
export async function loadOfferAnalytics(
  db: Db,
  shopId: string,
  offerId: string,
  now: () => Date = () => new Date(),
): Promise<OfferAnalytics | null> {
  const since30d = new Date(now().getTime() - 30 * DAY_MS);

  const [offerRows, funnelData, errorCounts, recentEventRows] = await Promise.all([
    db.select().from(offers)
      .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1),
    Promise.all(
      FUNNEL_EVENTS.map(async (step) => {
        const res = await db.select({ count: count() }).from(analyticsEvents)
          .where(and(
            eq(analyticsEvents.shopId, shopId),
            eq(analyticsEvents.eventName, step.event),
            eq(analyticsEvents.offerId, offerId),
            gte(analyticsEvents.occurredAt, since30d),
          ));
        return { label: step.label, count: res[0]?.count ?? 0 };
      }),
    ),
    Promise.all([
      db.select({ count: count() }).from(analyticsEvents)
        .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since30d))),
      db.select({ count: count() }).from(analyticsEvents)
        .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), gte(analyticsEvents.occurredAt, since30d))),
    ]),
    db
      .select({
        id: analyticsEvents.id,
        eventName: analyticsEvents.eventName,
        occurredAt: analyticsEvents.occurredAt,
      })
      .from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
      ))
      .orderBy(sql`${analyticsEvents.occurredAt} desc`)
      .limit(10),
  ]);
  const offer = offerRows[0];
  if (!offer) return null;
  const [errorCount, mutationCount] = errorCounts;

  const totalEvents = mutationCount[0]?.count ?? 0;
  const errorEvents = errorCount[0]?.count ?? 0;
  const errorRate = totalEvents > 0 ? ((errorEvents / totalEvents) * 100).toFixed(1) : "0";

  const impressions = funnelData[0]?.count ?? 0;
  const giftAdds = funnelData[2]?.count ?? 0;
  const addRate = impressions > 0 ? ((giftAdds / impressions) * 100).toFixed(1) : "0";

  return {
    offer: { id: offer.id, internalName: offer.internalName, type: offer.type, status: offer.status },
    funnelData,
    errorRate,
    totalEvents,
    impressions,
    giftAdds,
    addRate,
    recentEvents: recentEventRows.map((r) => ({
      id: r.id,
      eventName: r.eventName,
      occurredAt: r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
    })),
  };
}
