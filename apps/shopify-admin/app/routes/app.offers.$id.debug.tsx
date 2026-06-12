/**
 * Debug/Diagnostics panel for an individual offer.
 * Shows: compiled function config, metafield status, recent evaluation errors.
 */

import { useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, cartMutationLogs, analyticsEvents } from "@promo/db";
import { eq, and, desc, count, gte } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [offerRows, recentErrors, mutationErrors, statsViewed, statsAdded, statsErrors] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"),
      ))
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(10),
    db.select().from(cartMutationLogs)
      .where(and(
        eq(cartMutationLogs.shopId, shopId),
        eq(cartMutationLogs.offerId, offerId),
        eq(cartMutationLogs.status, "error"),
      ))
      .orderBy(desc(cartMutationLogs.createdAt))
      .limit(10),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "widget_viewed"),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "gift_auto_added"),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
  ]);

  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const compiledConfig = offer.compiledConfig;
  const hasCompiledConfig = !!compiledConfig;
  const configSize = compiledConfig ? JSON.stringify(compiledConfig).length : 0;

  const metafieldStatus = offer.functionMetafieldGid
    ? (hasCompiledConfig ? "synced" : "pending")
    : "error";

  return {
    offer: {
      id: offer.id,
      internalName: offer.internalName,
      status: offer.status,
      functionMetafieldGid: offer.functionMetafieldGid,
      hasCompiledConfig,
      configSize,
      compiledConfigJson: hasCompiledConfig ? JSON.stringify(compiledConfig, null, 2) : null,
      metafieldStatus,
      lastSyncTime: offer.updatedAt ? new Date(offer.updatedAt).toISOString() : null,
    },
    recentErrors: recentErrors.map((e) => ({
      occurred: e.occurredAt.toISOString(),
      eventName: e.eventName,
      sessionId: e.sessionId ?? "—",
      properties: JSON.stringify(e.properties).slice(0, 120),
    })),
    mutationErrors: mutationErrors.map((e) => ({
      created: e.createdAt.toISOString(),
      type: e.mutationType,
      error: e.errorMessage ?? "—",
      source: e.source,
    })),
    eventStats: {
      widgetViewed: statsViewed[0]?.value ?? 0,
      giftAutoAdded: statsAdded[0]?.value ?? 0,
      errors: statsErrors[0]?.value ?? 0,
    },
  };
};

export const action = async ({ request, params: _params }: ActionFunctionArgs) => {
  await getShopContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "republish_config") {
    // Force republish — handled by caller
    return { ok: true };
  }
  if (intent === "clear_logs") {
    // Clear logs — handled by caller
    return { ok: true };
  }
  return { ok: false };
};

function metafieldBadgeClass(status: string) {
  if (status === "synced") return "b-badge b-badge-green";
  if (status === "pending") return "b-badge b-badge-orange";
  return "b-badge b-badge-gray";
}

export default function OfferDebugPage() {
  const { offer, recentErrors, mutationErrors, eventStats } = useLoaderData<typeof loader>();

  const allErrors = [
    ...recentErrors.map((e) => ({
      time: e.occurred,
      event: e.eventName,
      cartId: e.sessionId,
      message: e.properties,
    })),
    ...mutationErrors.map((e) => ({
      time: e.created,
      event: e.type,
      cartId: e.source,
      message: e.error,
    })),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Debug & Diagnostics" subtitle={offer.internalName} backTo={`/app/offers/${offer.id}`} />

      {/* Main + sidebar layout */}
      <div className="b-editor-layout">
        {/* Main column */}
        <div className="b-editor-main">

          {/* Function Config card */}
          <div className="b-card">
            <div className="b-card-header b-row-between">
              <span>Function Config</span>
              <button
                className="b-btn b-btn-secondary b-btn-sm"
                onClick={() => {
                  if (offer.compiledConfigJson) {
                    void navigator.clipboard.writeText(offer.compiledConfigJson);
                  }
                }}
                disabled={!offer.compiledConfigJson}
              >
                Copy
              </button>
            </div>
            <div className="b-card-body">
              {offer.compiledConfigJson ? (
                <pre
                  style={{
                    margin: 0,
                    fontSize: 12,
                    lineHeight: 1.55,
                    overflow: "auto",
                    maxHeight: 320,
                    background: "#111827",
                    color: "#e5e7eb",
                    padding: "14px 16px",
                    borderRadius: 6,
                    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                  }}
                >
                  <code>{offer.compiledConfigJson}</code>
                </pre>
              ) : (
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  No compiled config found for this offer.
                </p>
              )}
              {offer.compiledConfigJson && (
                <p className="b-text-xs b-text-muted b-mt-2" style={{ margin: "8px 0 0" }}>
                  {offer.configSize} bytes
                  {offer.functionMetafieldGid && (
                    <> &mdash; GID: {offer.functionMetafieldGid}</>
                  )}
                </p>
              )}
            </div>
          </div>

          {/* Metafield Status card */}
          <div className="b-card">
            <div className="b-card-header">Metafield Status</div>
            <div className="b-card-body b-row b-gap-3">
              <span className={metafieldBadgeClass(offer.metafieldStatus)}>
                {offer.metafieldStatus}
              </span>
              {offer.lastSyncTime && (
                <span className="b-text-sm b-text-sub">
                  Last sync: {new Date(offer.lastSyncTime).toLocaleString()}
                </span>
              )}
              {!offer.lastSyncTime && (
                <span className="b-text-sm b-text-muted">Never synced</span>
              )}
            </div>
          </div>

          {/* Recent Errors card */}
          <div className="b-card">
            <div className="b-card-header">Recent Errors</div>
            {allErrors.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="b-table">
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: 16, width: "auto" }}>Time</th>
                      <th>Event</th>
                      <th>Cart ID</th>
                      <th>Error Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allErrors.map((row, i) => (
                      <tr key={i}>
                        <td style={{ paddingLeft: 16, whiteSpace: "nowrap" }}>
                          {new Date(row.time).toLocaleString()}
                        </td>
                        <td>
                          <span className="b-type-chip">{row.event}</span>
                        </td>
                        <td className="b-text-sm b-text-sub b-truncate" style={{ maxWidth: 120 }}>
                          {row.cartId.length > 14 ? row.cartId.slice(0, 14) + "…" : row.cartId}
                        </td>
                        <td className="b-text-sm b-truncate" style={{ maxWidth: 280 }}>
                          {row.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="b-card-body">
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  No errors recorded for this offer.
                </p>
              </div>
            )}
          </div>

          {/* Event Stats (7 days) card */}
          <div className="b-card">
            <div className="b-card-header">Event Stats (7 days)</div>
            <div className="b-card-body">
              <div style={{ display: "flex", gap: 12 }}>
                {/* widget_viewed */}
                <div
                  style={{
                    flex: 1,
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--r)",
                    padding: "14px 16px",
                  }}
                >
                  <div className="b-text-xs b-text-muted" style={{ marginBottom: 6 }}>
                    widget_viewed
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", lineHeight: 1 }}>
                    {eventStats.widgetViewed.toLocaleString()}
                  </div>
                </div>

                {/* gift_auto_added */}
                <div
                  style={{
                    flex: 1,
                    background: "var(--green-bg)",
                    border: "1px solid #a7d9c8",
                    borderRadius: "var(--r)",
                    padding: "14px 16px",
                  }}
                >
                  <div className="b-text-xs b-text-muted" style={{ marginBottom: 6 }}>
                    gift_auto_added
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--green)", lineHeight: 1 }}>
                    {eventStats.giftAutoAdded.toLocaleString()}
                  </div>
                </div>

                {/* errors */}
                <div
                  style={{
                    flex: 1,
                    background: "var(--red-bg)",
                    border: "1px solid #fca5a5",
                    borderRadius: "var(--r)",
                    padding: "14px 16px",
                  }}
                >
                  <div className="b-text-xs b-text-muted" style={{ marginBottom: 6 }}>
                    errors
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--red)", lineHeight: 1 }}>
                    {eventStats.errors.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Sidebar */}
        <div className="b-editor-sidebar">
          <div className="b-card">
            <div className="b-card-header">Quick Actions</div>
            <div className="b-card-body b-stack b-stack-3">
              <Form method="post">
                <input type="hidden" name="intent" value="republish_config" />
                <button
                  type="submit"
                  className="b-btn b-btn-primary b-w-full"
                  style={{ justifyContent: "center" }}
                >
                  Force Republish
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="clear_logs" />
                <button
                  type="submit"
                  className="b-btn b-btn-danger b-w-full"
                  style={{ justifyContent: "center" }}
                >
                  Clear Logs
                </button>
              </Form>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
