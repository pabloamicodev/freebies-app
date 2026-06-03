/**
 * Diagnostics / Debug page
 * Shows sync status, webhook status, metafield config, and error rates.
 * Accessible from admin navigation (Debug / Diagnostics).
 */

import { useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, offers, productCache, variantCache, analyticsEvents, cartMutationLogs } from "@promo/db";
import { eq, and, count, gte } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select()
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return { shop: null, diagnostics: null };

  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeOfferCount,
    productCacheCount,
    variantCacheCount,
    recentErrors,
    recentMutations,
    errorMutations,
  ] = await Promise.all([
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shop.id), eq(offers.status, "active"))),
    db.select({ count: count() }).from(productCache).where(eq(productCache.shopId, shop.id)),
    db.select({ count: count() }).from(variantCache).where(eq(variantCache.shopId, shop.id)),
    db.select({ count: count() }).from(analyticsEvents).where(
      and(eq(analyticsEvents.shopId, shop.id), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since1h))
    ),
    db.select({ count: count() }).from(cartMutationLogs).where(
      and(eq(cartMutationLogs.shopId, shop.id), gte(cartMutationLogs.createdAt, since24h))
    ),
    db.select({ count: count() }).from(cartMutationLogs).where(
      and(eq(cartMutationLogs.shopId, shop.id), eq(cartMutationLogs.status, "error"), gte(cartMutationLogs.createdAt, since24h))
    ),
  ]);

  const totalMutations = recentMutations[0]?.count ?? 0;
  const errorCount = errorMutations[0]?.count ?? 0;
  const errorRate = totalMutations > 0 ? ((errorCount / totalMutations) * 100).toFixed(1) : "0";

  return {
    shop: {
      domain: shop.shopDomain,
      isActive: shop.isActive,
      installedAt: shop.installedAt.toISOString(),
      plan: shop.planName,
    },
    diagnostics: {
      activeOffers: activeOfferCount[0]?.count ?? 0,
      cachedProducts: productCacheCount[0]?.count ?? 0,
      cachedVariants: variantCacheCount[0]?.count ?? 0,
      errorsLastHour: recentErrors[0]?.count ?? 0,
      mutationsLast24h: totalMutations,
      errorMutationsLast24h: errorCount,
      errorRate,
    },
  };
};

// ── Icons ────────────────────────────────────────────────────

function IconDatabase() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

function IconQueue() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
    </svg>
  );
}

function IconShopify() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  );
}

function IconFunction() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h16v3"/>
      <path d="M9 20h6"/>
      <path d="M12 4v16"/>
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
    >
      <path d="M9 18l6-6-6-6"/>
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6"/>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
      <path d="M3 22v-6h6"/>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
    </svg>
  );
}

// ── Health check card ────────────────────────────────────────

type CheckStatus = "ok" | "warn" | "error";

interface HealthCheck {
  id: string;
  label: string;
  description: string;
  status: CheckStatus;
  value: string;
  detail?: string;
  icon: React.ReactNode;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") {
    return <span className="b-badge b-badge-green">Healthy</span>;
  }
  if (status === "warn") {
    return <span className="b-badge b-badge-orange">Warning</span>;
  }
  return <span className="b-badge" style={{ background: "var(--red-bg)", color: "var(--red)" }}>Error</span>;
}

function HealthCard({ check }: { check: HealthCheck }) {
  const [expanded, setExpanded] = useState(false);

  const iconBg =
    check.status === "ok"
      ? "var(--green-bg)"
      : check.status === "warn"
      ? "var(--orange-badge)"
      : "var(--red-bg)";
  const iconColor =
    check.status === "ok"
      ? "var(--green)"
      : check.status === "warn"
      ? "var(--orange-txt)"
      : "var(--red)";

  return (
    <div className="b-card">
      <div className="b-card-body">
        <div className="b-row-between" style={{ gap: 12 }}>
          <div className="b-row b-gap-3" style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "var(--r-sm)",
                background: iconBg,
                color: iconColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {check.icon}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="b-row b-gap-2" style={{ marginBottom: 2 }}>
                <span className="b-text-bold">{check.label}</span>
                <StatusBadge status={check.status} />
              </div>
              <div className="b-text-sm b-text-sub">{check.description}</div>
            </div>
          </div>
          <div className="b-row b-gap-3" style={{ flexShrink: 0 }}>
            <span className="b-text-bold" style={{ fontSize: 16 }}>{check.value}</span>
            {check.detail && (
              <button
                className="b-btn-icon"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "Collapse details" : "Expand details"}
              >
                <IconChevron open={expanded} />
              </button>
            )}
          </div>
        </div>

        {check.detail && expanded && (
          <>
            <hr className="b-divider" />
            <div
              style={{
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
                padding: "10px 14px",
                fontFamily: "monospace",
                fontSize: 12,
                color: "var(--text-sub)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {check.detail}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export default function DiagnosticsPage() {
  const { shop, diagnostics } = useLoaderData<typeof loader>();
  const [running, setRunning] = useState(false);

  if (!shop || !diagnostics) {
    return (
      <div className="b-page">
        <div className="b-page-header">
          <h1 className="b-page-title">Diagnostics</h1>
        </div>
        <div className="b-banner b-banner-red">
          <span className="b-banner-icon">⚠</span>
          <div className="b-banner-body">
            <div className="b-banner-title">Shop not found</div>
            <p className="b-banner-text">Unable to load diagnostic data for this shop.</p>
          </div>
        </div>
      </div>
    );
  }

  const highErrorRate = parseFloat(diagnostics.errorRate) >= 5;
  const noCache = diagnostics.cachedProducts === 0;
  const hasErrors = diagnostics.errorsLastHour > 0;

  const overallStatus: CheckStatus =
    hasErrors || highErrorRate ? "error" : noCache ? "warn" : "ok";

  const checks: HealthCheck[] = [
    {
      id: "db",
      label: "Database",
      description: "Active offers and cache rows loaded from Postgres",
      status: noCache ? "warn" : "ok",
      value: `${diagnostics.activeOffers} offers`,
      detail: noCache
        ? `Active offers: ${diagnostics.activeOffers}\nCached products: ${diagnostics.cachedProducts}\nCached variants: ${diagnostics.cachedVariants}\n\nWarning: product cache is empty. Run a manual product sync.`
        : `Active offers: ${diagnostics.activeOffers}\nCached products: ${diagnostics.cachedProducts}\nCached variants: ${diagnostics.cachedVariants}`,
      icon: <IconDatabase />,
    },
    {
      id: "queue",
      label: "Cart Mutation Queue",
      description: "Cart mutation throughput and error rate over the last 24 h",
      status: highErrorRate ? "error" : hasErrors ? "warn" : "ok",
      value: `${diagnostics.mutationsLast24h} mutations`,
      detail: [
        `Mutations (24 h): ${diagnostics.mutationsLast24h}`,
        `Error mutations (24 h): ${diagnostics.errorMutationsLast24h}`,
        `Error rate (24 h): ${diagnostics.errorRate}%`,
        highErrorRate
          ? "\nError rate above 5% — check storefront runtime and cart adapter."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      icon: <IconQueue />,
    },
    {
      id: "shopify",
      label: "Shopify Connection",
      description: `Shop ${shop.domain} — plan ${shop.plan ?? "unknown"}`,
      status: shop.isActive ? "ok" : "warn",
      value: shop.isActive ? "Connected" : "Inactive",
      detail: [
        `Domain: ${shop.domain}`,
        `Plan: ${shop.plan ?? "unknown"}`,
        `Active: ${shop.isActive}`,
        `Installed: ${new Date(shop.installedAt).toLocaleString()}`,
      ].join("\n"),
      icon: <IconShopify />,
    },
    {
      id: "function",
      label: "Promo Function",
      description: "Cart mutation errors fired in the last hour",
      status: hasErrors ? "error" : "ok",
      value: `${diagnostics.errorsLastHour} errors / h`,
      detail:
        hasErrors
          ? `Errors last hour: ${diagnostics.errorsLastHour}\n\nReview cart_mutation_logs for details. Check the storefront cart adapter and deployed function version.`
          : `Errors last hour: ${diagnostics.errorsLastHour}\nNo recent errors detected.`,
      icon: <IconFunction />,
    },
  ];

  const handleRunChecks = () => {
    setRunning(true);
    // Reload the page to re-run the loader
    window.location.reload();
  };

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <h1 className="b-page-title">Diagnostics</h1>
          <StatusBadge status={overallStatus} />
        </div>
        <div className="b-page-actions">
          <button
            className="b-btn b-btn-secondary"
            onClick={handleRunChecks}
            disabled={running}
          >
            <IconRefresh />
            {running ? "Running…" : "Run Checks"}
          </button>
        </div>
      </div>

      {/* Shop meta strip */}
      <div
        className="b-card b-mb-4"
        style={{ marginBottom: 16 }}
      >
        <div className="b-card-body" style={{ padding: "12px 20px" }}>
          <div className="b-row b-gap-3">
            <span className="b-text-sub b-text-sm">{shop.domain}</span>
            <span className="b-text-muted b-text-sm">·</span>
            <span className="b-text-sub b-text-sm">
              Installed {new Date(shop.installedAt).toLocaleDateString()}
            </span>
            {shop.plan && (
              <>
                <span className="b-text-muted b-text-sm">·</span>
                <span className="b-text-sm">{shop.plan}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Warning banners */}
      {noCache && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 12 }}>
          <span className="b-banner-icon">⚠</span>
          <div className="b-banner-body">
            <div className="b-banner-title">No products in cache</div>
            <p className="b-banner-text">
              Product sync has not run or completed. Run a manual sync to populate the cache.
            </p>
          </div>
        </div>
      )}
      {hasErrors && (
        <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
          <span className="b-banner-icon">✕</span>
          <div className="b-banner-body">
            <div className="b-banner-title">
              {diagnostics.errorsLastHour} cart mutation error{diagnostics.errorsLastHour !== 1 ? "s" : ""} in the last hour
            </div>
            <p className="b-banner-text">
              Review the cart_mutation_logs table for details.
            </p>
          </div>
        </div>
      )}
      {highErrorRate && (
        <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
          <span className="b-banner-icon">✕</span>
          <div className="b-banner-body">
            <div className="b-banner-title">High mutation error rate: {diagnostics.errorRate}%</div>
            <p className="b-banner-text">
              Error rate above 5% indicates a systemic issue. Check storefront runtime and cart adapter.
            </p>
          </div>
        </div>
      )}

      {/* Health check cards */}
      <div className="b-stack b-stack-4" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="b-card-header b-card" style={{ borderRadius: "var(--r)", overflow: "hidden" }}>
          <div className="b-card-header">System Health Checks</div>
          <div style={{ padding: "12px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            {checks.map((check) => (
              <HealthCard key={check.id} check={check} />
            ))}
          </div>
        </div>
      </div>

      {/* Metrics table */}
      <div className="b-card" style={{ marginTop: 16 }}>
        <div className="b-card-header">Raw Metrics</div>
        <div className="b-table-wrap" style={{ border: "none", borderRadius: 0, boxShadow: "none" }}>
          <table className="b-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ textAlign: "right" }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Active offers", String(diagnostics.activeOffers)],
                ["Cached products", String(diagnostics.cachedProducts)],
                ["Cached variants", String(diagnostics.cachedVariants)],
                ["Cart mutation errors (last hour)", String(diagnostics.errorsLastHour)],
                ["Cart mutations (last 24 h)", String(diagnostics.mutationsLast24h)],
                ["Error mutations (last 24 h)", String(diagnostics.errorMutationsLast24h)],
                ["Mutation error rate (24 h)", `${diagnostics.errorRate}%`],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td className="b-text-sm">{label}</td>
                  <td className="b-text-sm b-text-bold" style={{ textAlign: "right" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
