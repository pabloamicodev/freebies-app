import { useLoaderData, Link } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, shops, analyticsEvents } from "@promo/db";
import { eq, and, count, gte, desc } from "drizzle-orm";
import { getDashboardWarnings } from "../lib/dashboard-warnings.server.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  try {
    const db = getDb();
    const shopRows = await db
      .select({ id: shops.id, shopDomain: shops.shopDomain, currencyCode: shops.currencyCode })
      .from(shops)
      .where(eq(shops.myshopifyDomain, shopDomain))
      .limit(1);
    const shopRow = shopRows[0];
    const shopId = shopRow?.id ?? "";
    const shopDisplayName = shopRow?.shopDomain
      ? shopRow.shopDomain.replace(/\.myshopify\.com$/, "").replace(/-/g, " ")
      : shopDomain.replace(/\.myshopify\.com$/, "");
    const currencyCode = shopRow?.currencyCode ?? "USD";

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [activeOffersResult, orderEventRows] = await Promise.all([
      db.select({ count: count() }).from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")))
        .catch(() => [{ count: 0 }]),
      db.select({ properties: analyticsEvents.properties })
        .from(analyticsEvents)
        .where(and(
          eq(analyticsEvents.shopId, shopId),
          eq(analyticsEvents.eventName, "promo_engine:order_paid"),
          gte(analyticsEvents.occurredAt, since30d),
        ))
        .orderBy(desc(analyticsEvents.occurredAt))
        .limit(500)
        .catch(() => []),
    ]);

    const warnings = await getDashboardWarnings(shopId, shopDomain).catch(() => []);

    // Aggregate real order stats from events
    let totalSalesCents = 0;
    for (const row of orderEventRows) {
      const props = row.properties as Record<string, unknown> | null;
      const subtotal = typeof props?.subtotalCents === "number" ? props.subtotalCents : 0;
      totalSalesCents += subtotal;
    }
    const orderCount = orderEventRows.length;
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
      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  );
}

export default function Dashboard() {
  const { activeOffers, shopDisplayName, currencyCode, totalSalesCents, orderCount, avgOrderCents } = useLoaderData<typeof loader>();
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [showRecommended, setShowRecommended] = useState(true);

  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode, maximumFractionDigits: 0 });
  const totalSalesFmt = fmt.format(totalSalesCents / 100);
  const avgOrderFmt = fmt.format(avgOrderCents / 100);

  const onboardingSteps = [
    { label: "Enable BOGOS in themes", done: true },
    { label: "Create your first offer", done: activeOffers > 0 },
    { label: "Check the offer in your Online Store", done: false },
    { label: "Customize the appearance", done: false },
  ];
  const completedSteps = onboardingSteps.filter((s) => s.done).length;
  const progressPct = Math.round((completedSteps / onboardingSteps.length) * 100);

  const supportLinks = [
    { icon: "💬", title: "Live chat support", desc: "Get help from our highly trained support team", href: "https://secomapp.com/contact" },
    { icon: "❓", title: "View frequently asked questions", desc: "See FAQs and learn about BOGOS functionality", href: "https://help.secomapp.com" },
    { icon: "▶️", title: "Watch our YouTube series", desc: "See all guides step by step on our YouTube series", href: "https://www.youtube.com/@secomapp" },
    { icon: "✉️", title: "Contact via email", desc: "Send us an email at support@secomapp.com for help", href: "mailto:support@secomapp.com" },
  ];

  const recApps = [
    { color: "#f97316", initial: "N", badge: "20% OFF – FATHERS20PER", name: "Notim: Back In Stock+Notify Me", desc: "Notify customers on restocks, get inventory alerts, and manage stock across locations." },
    { color: "#16a34a", initial: "X", badge: null, name: "XFlow Back in Stock Alert", desc: "Automated, personalized back in stock alerts that re-engage customers and recover lost sales." },
    { color: "#7c3aed", initial: "E", badge: null, name: "Ego Cart Drawer Cart Upsell", desc: "Boost AOV & CR with the top upsell solution. Try Ego Cart Upsell with upsell cart, cross-selling." },
  ];

  return (
    <div className="b-page">
      {/* ── Page Header ─────────────────────────────────────── */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <h1 className="b-page-title">Panel</h1>
          <span className="b-status-pill b-status-pill-green">
            <span className="b-status-dot" />
            {activeOffers} active offer{activeOffers !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* ── BOGOS Status + Plan row ─────────────────────────── */}
      <div className="b-grid-2 b-mb-4">
        <div className="b-card b-card-body">
          <div className="b-row b-gap-2 b-mb-4" style={{ marginBottom: 6 }}>
            <span className="b-text-sm b-text-sub">BOGOS Status</span>
            <span className="b-badge b-badge-green">Activated</span>
          </div>
          <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>BOGOS is active in your theme.</p>
        </div>
        <div className="b-card b-card-body">
          <div className="b-row b-gap-2 b-mb-4" style={{ marginBottom: 6 }}>
            <span className="b-text-sm b-text-sub">Application plan</span>
            <span className="b-badge b-badge-green">Full plan</span>
          </div>
          <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
            You&apos;re on the full plan.<br />All features unlocked!
          </p>
        </div>
      </div>

      {/* ── Expert Consultation Dark Banner ─────────────────── */}
      <div className="b-dark-banner b-mb-4">
        <div className="b-dark-banner-body">
          <h3 className="b-dark-banner-title">FREE check with experts</h3>
          <p className="b-dark-banner-sub">Don&apos;t miss it! A quick consultation with our team guarantees your personalized discounts will be active and ready to get you more sales. 🚀</p>
          <button className="b-dark-banner-btn">View offers</button>
        </div>
        <div className="b-team-avatars">
          <div className="b-avatar b-avatar-1">A</div>
          <div className="b-avatar b-avatar-2">B</div>
          <div className="b-avatar b-avatar-3">C</div>
          <div className="b-avatar b-avatar-4">D</div>
        </div>
      </div>

      {/* ── Welcome + Stats row ──────────────────────────────── */}
      <div className="b-mb-4" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Welcome card */}
        <div className="b-card b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 6px", color: "var(--text)" }}>
              Welcome to BOGOS, {shopDisplayName}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-sub)", margin: "0 0 16px" }}>
              Create an offer and increase your AOV now
            </p>
            <Link to="/app/offers/new" className="b-btn b-btn-primary">Create offer</Link>
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
          <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "var(--text)" }}>Overview</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              { label: "Total sales (30d)", value: totalSalesFmt },
              { label: "Average order value (30d)", value: avgOrderFmt },
              { label: "Orders with gifts (30d)", value: String(orderCount) },
            ].map((row, i) => (
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
                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{row.value}</span>
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
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>BOGOS Getting Started Guide</h3>
              <button
                onClick={() => setShowOnboarding(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 18, lineHeight: 1, padding: "2px 4px" }}
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
                  <div className={`b-check-circle ${step.done ? "b-check-circle-done" : "b-check-circle-todo"}`}>
                    {step.done && <IconCheck />}
                  </div>
                  <span className="b-check-text">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Recommended Apps ─────────────────────────────────── */}
      {showRecommended && (
        <div className="b-card b-mb-4">
          <div className="b-card-body">
            <div className="b-row-between" style={{ marginBottom: 14 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Recommended apps for you</h3>
              <button
                onClick={() => setShowRecommended(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 18, lineHeight: 1, padding: "2px 4px" }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <div className="b-rec-apps">
              {recApps.map((app) => (
                <div key={app.name} className="b-rec-app-card">
                  <div
                    className="b-rec-app-icon"
                    style={{ background: app.color, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 20 }}
                  >
                    {app.initial}
                  </div>
                  {app.badge && <div className="b-rec-app-badge">{app.badge}</div>}
                  <div className="b-rec-app-name">{app.name}</div>
                  <div className="b-rec-app-desc">{app.desc}</div>
                  <button className="b-btn b-btn-secondary b-btn-sm">Install now</button>
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
            {supportLinks.map((link) => (
              <a key={link.title} href={link.href} className="b-support-card">
                <div className="b-support-icon" style={{ background: "var(--border-light)" }}>{link.icon}</div>
                <div>
                  <div className="b-support-title">{link.title}</div>
                  <div className="b-support-desc">{link.desc}</div>
                </div>
                <div className="b-support-chevron"><IconChevron /></div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
