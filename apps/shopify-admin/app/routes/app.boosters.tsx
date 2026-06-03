/**
 * Boosters — Today Offer widget and Progress Bar configuration.
 * Boosters are offers that "boost" visibility of existing offers
 * via floating widgets, progress bars, and cart messages.
 */

import { useLoaderData, useNavigate, Form } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, offers, widgets } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const [shopRow] = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";

  const boosterOffers = await db.select().from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.type, "booster")))
    .orderBy(offers.priority);

  const boosterWidgets = await db.select().from(widgets)
    .where(eq(widgets.shopId, shopId));

  return {
    boosters: boosterOffers.map((o) => ({
      id: o.id,
      internalName: o.internalName,
      publicTitle: o.publicTitle,
      status: o.status,
      priority: o.priority,
      updatedAt: o.updatedAt.toISOString(),
    })),
    widgets: boosterWidgets.filter((w) =>
      ["today_offer_widget", "today_offer_block", "progress_bar"].includes(w.type)
    ).map((w) => ({
      id: w.id,
      type: w.type,
      internalName: w.internalName,
      isEnabled: w.isEnabled,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const widgetId = formData.get("widgetId") as string;

  if (intent === "toggle_widget") {
    const enabled = formData.get("enabled") === "true";
    await db.update(widgets).set({ isEnabled: enabled, updatedAt: new Date() })
      .where(eq(widgets.id, widgetId));
  }
  return null;
};

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  active:   { cls: "b-badge b-badge-green",  label: "Active" },
  draft:    { cls: "b-badge b-badge-blue",   label: "Draft" },
  paused:   { cls: "b-badge b-badge-orange", label: "Paused" },
  archived: { cls: "b-badge b-badge-gray",   label: "Archived" },
};

const WIDGET_TYPE_LABEL: Record<string, string> = {
  today_offer_widget: "🚀 Today Offer (Floating)",
  today_offer_block:  "📌 Today Offer (Inline Block)",
  progress_bar:       "📊 Progress Bar",
};

export default function BoostersPage() {
  const { boosters, widgets: boosterWidgets } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <div className="b-page">
      {/* ── Header ────────────────────────────────────────── */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <h1 className="b-page-title">Boosters</h1>
        </div>
        <div className="b-page-actions">
          <a
            href="/app/offers/new?type=booster"
            className="b-btn b-btn-primary"
          >
            + Create Booster
          </a>
        </div>
      </div>

      {/* ── Info banner ───────────────────────────────────── */}
      <div className="b-banner">
        <div className="b-banner-icon">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5" />
            <path d="M10 9v5" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="6.5" r="0.75" fill="#2c6ecb" />
          </svg>
        </div>
        <div className="b-banner-body">
          <div className="b-banner-title">What are Boosters?</div>
          <p className="b-banner-text">
            Boosters are floating widgets and progress bars that increase visibility of your active
            gift, bundle, and discount offers. They do not create new promotions — they promote existing ones.
          </p>
        </div>
      </div>

      {/* ── Main + sidebar layout ─────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "16px", alignItems: "start" }}>

        {/* Left column */}
        <div className="b-stack b-stack-4">

          {/* Configured Widgets card */}
          <div className="b-card">
            <div className="b-card-header">Configured Widgets</div>
            <div className="b-card-body">
              {boosterWidgets.length === 0 ? (
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  No booster widgets configured. Create a booster offer and add a Today Offer or Progress Bar widget.
                </p>
              ) : (
                <div className="b-stack b-stack-3">
                  {boosterWidgets.map((w) => (
                    <div key={w.id} className="b-row-between" style={{ padding: "10px 0", borderBottom: "1px solid var(--border-light)" }}>
                      <div className="b-row b-gap-3">
                        <span className="b-text-bold">{WIDGET_TYPE_LABEL[w.type] ?? w.type}</span>
                        <span className="b-text-sm b-text-sub">{w.internalName}</span>
                      </div>
                      <div className="b-row b-gap-3">
                        <span className={w.isEnabled ? "b-badge b-badge-green" : "b-badge b-badge-gray"}>
                          {w.isEnabled ? "Enabled" : "Disabled"}
                        </span>
                        <Form method="POST">
                          <input type="hidden" name="intent" value="toggle_widget" />
                          <input type="hidden" name="widgetId" value={w.id} />
                          <input type="hidden" name="enabled" value={String(!w.isEnabled)} />
                          <button
                            type="submit"
                            className={`b-btn b-btn-sm ${w.isEnabled ? "b-btn-danger" : "b-btn-secondary"}`}
                          >
                            {w.isEnabled ? "Disable" : "Enable"}
                          </button>
                        </Form>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Booster Offers card */}
          <div className="b-card">
            <div className="b-card-header">Booster Offers</div>

            {boosters.length === 0 ? (
              <div className="b-card-body" style={{ textAlign: "center", padding: "48px 24px" }}>
                <div style={{ fontSize: "40px", marginBottom: "12px" }}>🚀</div>
                <p className="b-text-bold" style={{ fontSize: "15px", margin: "0 0 6px" }}>No booster offers yet</p>
                <p className="b-text-sm b-text-sub" style={{ margin: "0 0 20px" }}>
                  Create a booster to add Today Offer widgets and progress bars to your store.
                </p>
                <a href="/app/offers/new?type=booster" className="b-btn b-btn-primary">
                  + Create Booster
                </a>
              </div>
            ) : (
              <div className="b-table-wrap" style={{ border: "none", boxShadow: "none", borderRadius: 0 }}>
                <table className="b-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boosters.map((booster) => {
                      const badge = STATUS_BADGE[booster.status] ?? STATUS_BADGE["draft"]!;
                      return (
                        <tr
                          key={booster.id}
                          onClick={() => navigate(`/app/offers/${booster.id}`)}
                          style={{ cursor: "pointer" }}
                        >
                          <td>
                            <div className="b-offer-name">{booster.internalName}</div>
                            {booster.publicTitle && (
                              <div className="b-offer-subtitle">{booster.publicTitle}</div>
                            )}
                          </td>
                          <td>
                            <span className={badge.cls}>{badge.label}</span>
                          </td>
                          <td className="b-text-sm b-text-sub">{booster.priority}</td>
                          <td className="b-text-sm b-text-sub">
                            {new Date(booster.updatedAt).toLocaleDateString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar */}
        <div className="b-card">
          <div className="b-card-header">How to set up a Booster</div>
          <div className="b-card-body">
            <div className="b-checklist">
              <div className="b-check-item">
                <div className="b-check-circle b-check-circle-todo">
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-sub)" }}>1</span>
                </div>
                <div>
                  <p className="b-text-sm" style={{ margin: 0 }}>
                    <strong>Create a Booster offer</strong> using the "Create Booster" button above.
                  </p>
                </div>
              </div>
              <div className="b-check-item">
                <div className="b-check-circle b-check-circle-todo">
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-sub)" }}>2</span>
                </div>
                <div>
                  <p className="b-text-sm" style={{ margin: 0 }}>
                    <strong>Add a widget</strong> — choose "Today Offer" (floating) or "Progress Bar" in the offer settings.
                  </p>
                </div>
              </div>
              <div className="b-check-item">
                <div className="b-check-circle b-check-circle-todo">
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-sub)" }}>3</span>
                </div>
                <div>
                  <p className="b-text-sm" style={{ margin: 0 }}>
                    <strong>Link existing offers</strong> — connect gift, bundle, or discount offers so the booster promotes them.
                  </p>
                </div>
              </div>
              <div className="b-check-item">
                <div className="b-check-circle b-check-circle-todo">
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-sub)" }}>4</span>
                </div>
                <div>
                  <p className="b-text-sm" style={{ margin: 0 }}>
                    <strong>Publish the booster</strong> — the widget appears on your store automatically if App Embed is enabled.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
