/**
 * Per-offer analytics drill-down page.
 * Shows full funnel, top gift products, error rate, and A/B comparison.
 */

import { useLoaderData } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { analyticsEvents, offers } from "@promo/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const offerRows = await db.select().from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const FUNNEL_EVENTS = [
    { event: "promo_engine:widget_viewed", label: "Widget Viewed" },
    { event: "promo_engine:offer_qualified", label: "Offer Qualified" },
    { event: "promo_engine:gift_auto_added", label: "Gift Added" },
    { event: "checkout_started", label: "Checkout Started" },
    { event: "order_placed_attributed", label: "Order Placed" },
  ];

  const funnelData = await Promise.all(
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
  );

  // Error rate
  const [errorCount, mutationCount] = await Promise.all([
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since30d))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), gte(analyticsEvents.occurredAt, since30d))),
  ]);

  const totalEvents = mutationCount[0]?.count ?? 0;
  const errorEvents = errorCount[0]?.count ?? 0;
  const errorRate = totalEvents > 0 ? ((errorEvents / totalEvents) * 100).toFixed(1) : "0";

  // Derive stat card values from funnel data
  const impressions = funnelData[0]?.count ?? 0;
  const giftAdds = funnelData[2]?.count ?? 0;
  const addRate = impressions > 0 ? ((giftAdds / impressions) * 100).toFixed(1) : "0";

  // Recent events — last 10 from analyticsEvents for this offer
  const recentEventRows = await db
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
    .limit(10);

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
      occurredAt: r.occurredAt instanceof Date
        ? r.occurredAt.toISOString()
        : String(r.occurredAt),
    })),
  };
};

function fmtEventName(raw: string) {
  return raw
    .replace(/^promo_engine:/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function OfferAnalyticsPage() {
  const { offer, funnelData, errorRate, totalEvents, impressions, giftAdds, addRate, recentEvents } =
    useLoaderData<typeof loader>();

  const topCount = funnelData[0]?.count ?? 1;

  return (
    <div className="b-page">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <a
            href="/app/analytics"
            className="b-btn-icon"
            title="Back to All Analytics"
            style={{ color: "var(--text-sub)" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </a>
          <h1 className="b-page-title">{offer.internalName}</h1>
          <span className="b-type-chip">{offer.type}</span>
          <span className={`b-badge ${offer.status === "active" ? "b-badge-green" : "b-badge-orange"}`}>
            {offer.status}
          </span>
        </div>
        <div className="b-page-actions">
          <a
            href={`/api/offers/${offer.id}/export`}
            className="b-btn b-btn-secondary b-btn-sm"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Export CSV
          </a>
        </div>
      </div>

      {/* ── Stat Cards ─────────────────────────────────────── */}
      <div className="b-grid-3 b-mb-4">

        {/* Impressions */}
        <div className="b-card b-card-body">
          <div className="b-row b-gap-3">
            <div className="b-stat-icon b-stat-icon-purple">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
            <div>
              <div className="b-text-xs b-text-sub" style={{ marginBottom: 2 }}>Impressions</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>
                {impressions.toLocaleString()}
              </div>
              <div className="b-text-xs b-text-muted b-mt-2">Last 30 days</div>
            </div>
          </div>
        </div>

        {/* Gift Adds */}
        <div className="b-card b-card-body">
          <div className="b-row b-gap-3">
            <div className="b-stat-icon b-stat-icon-blue">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 12 20 22 4 22 4 12" />
                <rect x="2" y="7" width="20" height="5" />
                <line x1="12" y1="22" x2="12" y2="7" />
                <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
                <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
              </svg>
            </div>
            <div>
              <div className="b-text-xs b-text-sub" style={{ marginBottom: 2 }}>Gift Adds</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>
                {giftAdds.toLocaleString()}
              </div>
              <div className="b-text-xs b-text-muted b-mt-2">Last 30 days</div>
            </div>
          </div>
        </div>

        {/* Add Rate */}
        <div className="b-card b-card-body">
          <div className="b-row b-gap-3">
            <div className="b-stat-icon b-stat-icon-yellow">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </svg>
            </div>
            <div>
              <div className="b-text-xs b-text-sub" style={{ marginBottom: 2 }}>Add Rate</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>
                {addRate}%
              </div>
              <div className="b-text-xs b-text-muted b-mt-2">Impressions to gift add</div>
            </div>
          </div>
        </div>

      </div>

      {/* ── Conversion Funnel ──────────────────────────────── */}
      <div className="b-card b-mb-4">
        <div className="b-card-header">Conversion Funnel — Last 30 Days</div>
        <div className="b-card-body b-stack b-stack-3">
          {funnelData.map((step, i) => {
            const prev = funnelData[i - 1]?.count ?? step.count;
            const stepPct = prev > 0 ? Math.round((step.count / prev) * 100) : 100;
            const barPct = topCount > 0 ? Math.round((step.count / topCount) * 100) : 0;

            let pctColor = "var(--green)";
            if (i > 0) {
              if (stepPct <= 20) pctColor = "var(--red)";
              else if (stepPct <= 50) pctColor = "#d97706";
            }

            return (
              <div key={step.label}>
                <div className="b-row-between b-gap-3" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
                    {step.label}
                  </span>
                  <div className="b-row b-gap-3">
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      {step.count.toLocaleString()}
                    </span>
                    {i > 0 && (
                      <span style={{ fontSize: 12, fontWeight: 500, color: pctColor, minWidth: 36, textAlign: "right" }}>
                        {stepPct}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="b-progress">
                  <div
                    className="b-progress-fill"
                    style={{ width: `${i === 0 ? 100 : barPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Health & Recent Events (2-col) ─────────────────── */}
      <div className="b-grid-2">

        {/* Health Metrics */}
        <div className="b-card">
          <div className="b-card-header">Health Metrics</div>
          <table className="b-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ textAlign: "right" }}>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="b-text-sm">Total events (30d)</td>
                <td className="b-text-sm b-text-bold" style={{ textAlign: "right" }}>
                  {totalEvents.toLocaleString()}
                </td>
              </tr>
              <tr>
                <td className="b-text-sm">Cart mutation error rate</td>
                <td style={{ textAlign: "right" }}>
                  <span
                    className={`b-badge ${parseFloat(errorRate) > 5 ? "b-badge-orange" : "b-badge-green"}`}
                  >
                    {errorRate}%
                  </span>
                </td>
              </tr>
              <tr>
                <td className="b-text-sm">Status</td>
                <td style={{ textAlign: "right" }}>
                  <span className={`b-badge ${offer.status === "active" ? "b-badge-green" : "b-badge-orange"}`}>
                    {offer.status}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Recent Events */}
        <div className="b-card">
          <div className="b-card-header">Recent Events</div>
          {recentEvents.length === 0 ? (
            <div className="b-card-body b-text-sm b-text-sub" style={{ textAlign: "center", padding: "32px 20px" }}>
              No events recorded yet.
            </div>
          ) : (
            <table className="b-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th style={{ textAlign: "right" }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      <span className="b-truncate b-text-sm" style={{ display: "block", maxWidth: 180 }}>
                        {fmtEventName(ev.eventName)}
                      </span>
                    </td>
                    <td className="b-text-xs b-text-muted" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {fmtDate(ev.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>

    </div>
  );
}
