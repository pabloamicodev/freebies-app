/**
 * Debug/Diagnostics panel for an individual offer.
 * Shows: compiled function config, metafield status, recent evaluation errors.
 */

import { parseUuidParam } from "../lib/route-params.js";
import { useActionData, useLoaderData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { publishShopConfig } from "../lib/offer-publish-flow.server.js";
import { clearOfferDebugLogs, loadOfferDebug } from "../lib/offer-debug.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const debug = await loadOfferDebug(db, shopId, offerId);
  if (!debug) throw new Response("Not found", { status: 404 });
  return debug;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, shopDomain, db } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  await loadOwnedOffer(db, shopId, offerId);
  const intent = (await request.formData()).get("intent");

  if (intent === "republish_config") {
    const error = await publishShopConfig(shopId, shopDomain);
    return error ? { ok: false, message: error } : { ok: true, message: "Configuration republished to Shopify." };
  }
  if (intent === "clear_logs") {
    await clearOfferDebugLogs(db, shopId, offerId);
    return { ok: true, message: "Error logs cleared." };
  }
  return { ok: false, message: "Unsupported action." };
};

function metafieldBadgeClass(status: string) {
  if (status === "synced") return "b-badge b-badge-green";
  if (status === "pending") return "b-badge b-badge-orange";
  return "b-badge b-badge-gray";
}

export default function OfferDebugPage() {
  const { offer, recentErrors, mutationErrors, eventStats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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
              <button type="button"
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
                  className="rd-style-010"
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
                    {allErrors.map((row) => (
                      <tr key={`${row.time}:${row.event}:${row.cartId}:${row.message}`}>
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
              {actionData?.message && (
                <div className={`b-banner ${actionData.ok ? "b-banner-green" : "b-banner-red"}`} role={actionData.ok ? "status" : "alert"}>{actionData.message}</div>
              )}
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
