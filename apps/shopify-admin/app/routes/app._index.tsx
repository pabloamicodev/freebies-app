import { useLoaderData, Link } from "react-router";
import { useMemo, useCallback, useState } from "react";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, analyticsEvents } from "@promo/db";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { getDashboardWarnings } from "../lib/dashboard-warnings.server.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

const dashboardCurrencyFormatters = new Map<string, Intl.NumberFormat>();

function getDashboardCurrencyFormatter(currencyCode: string): Intl.NumberFormat {
  const key = currencyCode.toUpperCase();
  const cached = dashboardCurrencyFormatters.get(key);
  if (cached) return cached;

  const formatter = Intl.NumberFormat("en-US", {
    style: "currency",
    currency: key,
    maximumFractionDigits: 0,
  });
  dashboardCurrencyFormatters.set(key, formatter);
  return formatter;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shopId, shopDomain, currencyCode, db } = await getShopContext(request);

  try {
    const shopDisplayName = shopDomain.replace(/\.myshopify\.com$/, "").replace(/-/g, " ");

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [activeOffersResult, [totals]] = await Promise.all([
      db
        .select({ count: count() })
        .from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")))
        .catch(() => [{ count: 0 }]),
      // A SQL aggregate, not a capped row scan: the previous `.limit(2000)`
      // JS-side sum silently undercounted once a shop passed 2000 attributed
      // events in the window. One row is written per attributed offer, so an
      // order with two offers produces two rows — DISTINCT ON order_id dedupes
      // before summing, or a multi-offer order double-counts its own total.
      db.execute<{ total_sales_cents: string | null; order_count: number }>(sql`
        WITH deduped_orders AS (
          SELECT DISTINCT ON (order_id)
            order_id,
            COALESCE((properties->>'subtotalCents')::bigint, 0) AS subtotal_cents
          FROM analytics_events
          WHERE shop_id = ${shopId}
            AND event_name = 'order_placed_attributed'
            AND occurred_at >= ${since30d}
            AND order_id IS NOT NULL
          ORDER BY order_id, occurred_at DESC
        )
        SELECT COALESCE(SUM(subtotal_cents), 0)::bigint AS total_sales_cents, COUNT(*)::int AS order_count
        FROM deduped_orders
      `).catch(() => [{ total_sales_cents: "0", order_count: 0 }]),
    ]);

    const warnings = await getDashboardWarnings(shopId, shopDomain).catch(() => []);

    const totalSalesCents = Number(totals?.total_sales_cents ?? 0);
    const orderCount = Number(totals?.order_count ?? 0);
    const avgOrderCents = orderCount > 0 ? Math.round(totalSalesCents / orderCount) : 0;

    return {
      shopDomain,
      shopDisplayName,
      currencyCode,
      shopId,
      activeOffers: activeOffersResult[0]?.count ?? 0,
      totalSalesCents,
      orderCount,
      avgOrderCents,
      warnings,
    };
  } catch {
    return {
      shopDomain,
      shopDisplayName: shopDomain.replace(/\.myshopify\.com$/, ""),
      currencyCode: "USD",
      shopId: "",
      activeOffers: 0,
      totalSalesCents: 0,
      orderCount: 0,
      avgOrderCents: 0,
      warnings: [],
    };
  }
};

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconChevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

const DASHBOARD_SUPPORT_LINKS = [
  {
    icon: "📋",
    title: "Installation status",
    desc: "Check theme setup and extension status",
    href: "/app/settings/installation",
  },
  {
    icon: "🪲",
    title: "Error logs",
    desc: "Review recent errors reported by the app",
    href: "/app/logs",
  },
  {
    icon: "🩺",
    title: "Diagnostics",
    desc: "Inspect sync status and run manual checks",
    href: "/app/diagnostics",
  },
];

export default function Dashboard() {
  const {
    activeOffers,
    shopDisplayName,
    currencyCode,
    totalSalesCents,
    orderCount,
    avgOrderCents,
    warnings,
  } = useLoaderData<typeof loader>();
  const [showOnboarding, setShowOnboarding] = useState(true);

  const fmt = getDashboardCurrencyFormatter(currencyCode);
  const totalSalesFmt = fmt.format(totalSalesCents / 100);
  const avgOrderFmt = fmt.format(avgOrderCents / 100);

  const embedVerified = !warnings.some((w) => w.code === "app_embed_not_verified");

  const onboardingSteps = useMemo(
    () => [
      { label: "Enable Promo Engine in themes", done: embedVerified },
      { label: "Create your first offer", done: activeOffers > 0 },
      { label: "Check the offer in your Online Store", done: false },
      { label: "Customize the appearance", done: false },
    ],
    [activeOffers, embedVerified],
  );
  const completedSteps = onboardingSteps.filter((s) => s.done).length;
  const progressPct = Math.round((completedSteps / onboardingSteps.length) * 100);
  const statsRows = useMemo(
    () => [
      { label: "Total sales (30d)", value: totalSalesFmt },
      { label: "Average order value (30d)", value: avgOrderFmt },
      { label: "Orders with gifts (30d)", value: String(orderCount) },
    ],
    [totalSalesFmt, avgOrderFmt, orderCount],
  );
  const dismissOnboarding = useCallback(() => setShowOnboarding(false), []);

  return (
    <div className="b-page">
      {/* ── Page Header ─────────────────────────────────────── */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <h1 className="b-page-title">Dashboard</h1>
          <span className="b-status-pill b-status-pill-green">
            <span className="b-status-dot" />
            {activeOffers} active offer{activeOffers !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* ── App Status row ─────────────────────────── */}
      <div className="b-mb-4">
        <div className="b-card b-card-body">
          <div className="b-row b-gap-2 b-mb-4" style={{ marginBottom: 6 }}>
            <span className="b-text-sm b-text-sub">Theme app embed</span>
            <span className={`b-badge ${embedVerified ? "b-badge-green" : "b-badge-orange"}`}>
              {embedVerified ? "Enabled" : "Status unknown"}
            </span>
          </div>
          <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
            {embedVerified
              ? "Promo Engine is enabled in your theme."
              : "Enable the Promo Engine app embed in your theme editor to start showing offers."}
          </p>
        </div>
      </div>

      {/* ── Warnings ─────────────────────────────────────────── */}
      {warnings.length > 0 && (
        <div className="b-stack b-stack-2 b-mb-4">
          {warnings.map((warning) => (
            <div
              key={warning.code}
              className={`b-banner ${warning.severity === "error" ? "" : warning.severity === "warning" ? "b-banner-orange" : ""}`}
            >
              <div className="b-banner-body">
                <div className="b-banner-title">{warning.title}</div>
                <p className="b-banner-text">{warning.message}</p>
              </div>
              {warning.action && (
                <Link to={warning.action.url} className="b-btn b-btn-secondary b-btn-sm">
                  {warning.action.label}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Welcome + Stats row ──────────────────────────────── */}
      <div className="b-mb-4" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Welcome card */}
        <div
          className="b-card b-card-body"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px", color: "var(--text)" }}>
              Welcome to Promo Engine, {shopDisplayName}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-sub)", margin: "0 0 16px" }}>
              Create an offer and increase your AOV now
            </p>
            <Link to="/app/offers?create=1" className="b-btn b-btn-primary">
              Create offer
            </Link>
          </div>
          {/* Person + boxes illustration */}
          <div style={{ position: "relative", width: 120, height: 140, flexShrink: 0 }}>
            <div className="b-illus-head" />
            <div className="b-illus-body" />
            <div className="b-illus-arm-l" />
            <div className="b-illus-arm-r" />
            <div className="b-illus-boxes">
              <div className="b-illus-box b-illus-box-lg" />
              <div className="b-illus-box b-illus-box-md" />
              <div className="b-illus-box b-illus-box-sm" />
            </div>
            <div className="b-illus-legs">
              <div className="b-illus-leg" />
              <div className="b-illus-leg" />
            </div>
          </div>
        </div>

        {/* Stats overview */}
        <div className="b-card b-card-body">
          <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "var(--text)" }}>
            Overview
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {statsRows.map((row, i) => (
              <div
                key={row.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 0",
                  borderTop: i > 0 ? "1px solid var(--border-light)" : "none",
                }}
              >
                <span style={{ fontSize: 14, color: "var(--text)" }}>{row.label}</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Onboarding Guide ────────────────────────────────── */}
      {showOnboarding && (
        <div className="b-card b-mb-4">
          <div className="b-card-body">
            <div className="b-row-between" style={{ marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Getting Started Guide</h3>
              <button
                type="button"
                onClick={dismissOnboarding}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-sub)",
                  fontSize: 18,
                  lineHeight: 1,
                  padding: "2px 4px",
                }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "0 0 8px" }}>
              {completedSteps}/{onboardingSteps.length} steps completed
            </p>
            <div className="b-progress">
              <div className="b-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="b-checklist">
              {onboardingSteps.map((step) => (
                <div key={step.label} className="b-check-item">
                  <div
                    className={`b-check-circle ${step.done ? "b-check-circle-done" : "b-check-circle-todo"}`}
                  >
                    {step.done && <IconCheck />}
                  </div>
                  <span className="b-check-text">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Support ──────────────────────────────────────────── */}
      <div className="b-card">
        <div className="b-card-body">
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 14px" }}>Get support</h3>
          <div className="b-support-grid">
            {DASHBOARD_SUPPORT_LINKS.map((link) => (
              <Link key={link.title} to={link.href} className="b-support-card">
                <div className="b-support-icon" style={{ background: "var(--border-light)" }}>
                  {link.icon}
                </div>
                <div>
                  <div className="b-support-title">{link.title}</div>
                  <div className="b-support-desc">{link.desc}</div>
                </div>
                <div className="b-support-chevron">
                  <IconChevron />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
