import { useLoaderData, useSearchParams } from "react-router";
import { useState } from "react";
import { getShopContext } from "../lib/shop-context.server.js";
import { createRouteTimer } from "../lib/route-timing.server.js";
import { analyticsEvents, offers } from "@promo/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";
import {
  IconChevronDown, IconChevronLeft, IconChevronRight,
  IconSearch, IconDollar, IconClipboard, IconBox,
} from "../components/Icons.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const timer = createRouteTimer("app.analytics._index");
  const { shopId, db } = await timer.time("shop_context", () => getShopContext(request));

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (!shopId) {
    timer.done({ shopFound: false, days });
    return {
      orders: [],
      totalSalesCents: 0,
      avgOrderCents: 0,
      orderCount: 0,
      salesChartData: [],
      ordersChartData: [],
      days,
    };
  }

  // "order_placed_attributed" is the event reconcileOrderAttribution actually
  // writes (webhooks.$.tsx handleOrderPaid) — this previously read a
  // different, never-written event name, so the page always showed zeros.
  const ORDER_EVENT_NAME = "order_placed_attributed";

  const [recentOrderEvents, offerRows, dailyTotals] = await timer.time("analytics.parallel_queries", () =>
    Promise.all([
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
      // Totals/chart come from a SQL aggregate over the whole window, not the
      // 50-row page above — an order with several attributed offers writes
      // one row per offer, so this dedupes to one row per order before
      // summing (otherwise a multi-offer order inflates its own total).
      db.execute<{ day: string; sales_cents: string | null; order_count: number }>(sql`
        WITH deduped_orders AS (
          SELECT DISTINCT ON (order_id)
            order_id,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            COALESCE((properties->>'subtotalCents')::bigint, 0) AS subtotal_cents
          FROM analytics_events
          WHERE shop_id = ${shopId}
            AND event_name = ${ORDER_EVENT_NAME}
            AND occurred_at >= ${since}
            AND order_id IS NOT NULL
          ORDER BY order_id, occurred_at DESC
        )
        SELECT day, SUM(subtotal_cents)::bigint AS sales_cents, COUNT(*)::int AS order_count
        FROM deduped_orders
        GROUP BY day
      `),
    ]),
  );
  const offerNames: Record<string, string> = {};
  offerRows.forEach((o) => { offerNames[o.id] = o.internalName; });

  // Pre-seed every calendar day in the window (UTC) so the chart shows zeros
  // instead of gaps, keyed by plain ISO date — matches to_char(..., 'UTC',
  // 'YYYY-MM-DD') above exactly, with no locale/timezone parsing involved.
  const dayBuckets: Record<string, { sales: number; orders: number }> = {};
  for (let i = days - 1; i >= 0; i--) {
    const isoDay = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dayBuckets[isoDay] = { sales: 0, orders: 0 };
  }

  let totalSalesCents = 0;
  let orderCount = 0;
  for (const row of dailyTotals) {
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
    return [{
        id: ev.id,
        orderId: ev.orderId!,
        date: ev.occurredAt.toISOString(),
        giftName,
        totalCents: subtotalCents,
    }];
  });

  const salesChartData = Object.entries(dayBuckets).map(([iso, v]) => ({ x: formatIsoDayLabel(iso), y: v.sales / 100 }));
  const ordersChartData = Object.entries(dayBuckets).map(([iso, v]) => ({ x: formatIsoDayLabel(iso), y: v.orders }));

  timer.done({
    shopFound: true,
    days,
    orderEventCount: recentOrderEvents.length,
    offerCount: offerRows.length,
  });

  return {
    orders,
    totalSalesCents,
    avgOrderCents,
    orderCount,
    salesChartData,
    ordersChartData,
    days,
  };
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Formats a plain 'YYYY-MM-DD' string without going through Date/timezone
 * parsing, so the label always matches the UTC calendar day it was grouped by. */
function formatIsoDayLabel(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${MONTH_ABBR[(month ?? 1) - 1]} ${day}`;
}

const LINE_CHART_PAD = { top: 20, right: 16, bottom: 32, left: 44 };

/** Simple SVG line chart — renders a smooth line with area fill */
function LineChart({ data, yLabel, color = "#2c6ecb" }: { data: { x: string; y: number }[]; yLabel: string; color?: string }) {
  const W = 400;
  const H = 160;
  const PAD = LINE_CHART_PAD;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  if (data.length < 2) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: H, color: "var(--text-muted)", fontSize: 13 }}>
        No data yet
      </div>
    );
  }

  const maxY = Math.max(...data.map((d) => d.y), 1);
  const pts = data.map((d, i) => ({
    x: PAD.left + (i / (data.length - 1)) * chartW,
    y: PAD.top + chartH - (d.y / maxY) * chartH,
  }));

  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${pts[pts.length - 1]!.x.toFixed(1)},${(PAD.top + chartH).toFixed(1)} L${pts[0]!.x.toFixed(1)},${(PAD.top + chartH).toFixed(1)} Z`;

  // Y axis labels (3 levels)
  const yTicks = [0, Math.round(maxY / 2), maxY];
  // X axis labels (first, middle, last)
  const xIdxs = [0, Math.floor((data.length - 1) / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
      <defs>
        <linearGradient id={`area-${yLabel}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.12"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.01"/>
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {yTicks.map((tick) => {
        const y = PAD.top + chartH - (tick / maxY) * chartH;
        return (
          <g key={tick}>
            <line x1={PAD.left} y1={y} x2={PAD.left + chartW} y2={y} stroke="#f3f4f6" strokeWidth="1"/>
            <text x={PAD.left - 6} y={y + 4} fontSize="10" fill="#6d7175" textAnchor="end">
              {yLabel === "$" ? `$${tick}` : tick}
            </text>
          </g>
        );
      })}
      {/* X labels */}
      {xIdxs.map((idx) => (
        <text key={idx} x={pts[idx]!.x} y={H - 6} fontSize="10" fill="#6d7175" textAnchor="middle">
          {data[idx]!.x}
        </text>
      ))}
      {/* Area fill */}
      <path d={areaD} fill={`url(#area-${yLabel})`}/>
      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Dots */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="white" stroke={color} strokeWidth="1.5"/>
      ))}
    </svg>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AnalyticsPage() {
  const { orders, totalSalesCents, avgOrderCents, orderCount, salesChartData, ordersChartData, days } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const filteredOrders = orders.filter((o) =>
    !search || o.orderId.toLowerCase().includes(search.toLowerCase()) || o.giftName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="b-page">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="b-page-header">
        <h1 className="b-page-title">Analytics</h1>
      </div>

      {/* ── Filter chips ────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button type="button"
          className="b-filter-chip"
          onClick={() => {
            const d = days === 7 ? 30 : days === 30 ? 90 : 7;
            setSearchParams({ days: String(d) });
          }}
        >
          Last {days} days <IconChevronDown />
        </button>
      </div>

      {/* ── Stat cards ──────────────────────────────────────── */}
      <div className="b-grid-3 b-mb-4">
        <div className="b-card b-card-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              ${totalSalesCents > 0 ? (totalSalesCents / 100).toFixed(2) : "0.00"}
            </div>
            <div className="b-text-sm b-text-sub">Total sales</div>
          </div>
          <div className="b-stat-icon b-stat-icon-purple"><IconDollar /></div>
        </div>
        <div className="b-card b-card-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              ${avgOrderCents > 0 ? (avgOrderCents / 100).toFixed(2) : "0.00"}
            </div>
            <div className="b-text-sm b-text-sub">Average order value</div>
          </div>
          <div className="b-stat-icon b-stat-icon-blue"><IconClipboard /></div>
        </div>
        <div className="b-card b-card-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              {orderCount}
            </div>
            <div className="b-text-sm b-text-sub">Orders</div>
          </div>
          <div className="b-stat-icon b-stat-icon-yellow"><IconBox /></div>
        </div>
      </div>

      {/* ── Charts ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "var(--text)" }}>Total</p>
        <div className="b-grid-2 b-mb-4">
          <div className="b-card b-card-body">
            <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "var(--text)" }}>Total sales</p>
            <LineChart data={salesChartData} yLabel="$" />
            <div className="b-chart-legend">
              <div className="b-chart-legend-line" />
              <span>Total sales</span>
            </div>
          </div>
          <div className="b-card b-card-body">
            <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px", color: "var(--text)" }}>Total orders</p>
            <LineChart data={ordersChartData} yLabel="#" />
            <div className="b-chart-legend">
              <div className="b-chart-legend-line" />
              <span>Total orders</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Orders table ────────────────────────────────────── */}
      <div className="b-card">
        <div className="b-card-body" style={{ borderBottom: "1px solid var(--border-light)", paddingBottom: 14 }}>
          <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "var(--text)" }}>Orders</p>
          <div className="b-search-wrap">
            <span className="b-search-icon"><IconSearch /></span>
            <input
              aria-label="Search orders"
              className="b-search-input"
              placeholder="Search orders"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <table className="b-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Gift</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "32px", color: "var(--text-sub)", fontSize: 13 }}>
                  No orders with gifts yet. Analytics are collected once offers are active.
                </td>
              </tr>
            ) : (
              filteredOrders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <span className="b-text-sm" style={{ color: "var(--blue)", fontWeight: 500 }}>
                      {order.orderId}
                    </span>
                  </td>
                  <td><span className="b-text-sm b-text-sub">{formatDate(order.date)}</span></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <span>🎁</span>
                      <span>{order.giftName} <span style={{ color: "var(--text-sub)" }}>(100% off) x1</span></span>
                    </div>
                  </td>
                  <td><span className="b-text-sm">${(order.totalCents / 100).toFixed(2)}</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="b-pagination">
          <button type="button" className="b-page-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            <IconChevronLeft />
          </button>
          <button type="button" className="b-page-btn current">{page}</button>
          <button type="button" className="b-page-btn" onClick={() => setPage((p) => p + 1)}>
            <IconChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}
