/**
 * Widget / Display Settings — Step 5 of the offer builder wizard.
 * Configure widget type, placement, theme, and copy for each offer.
 */

import { useLoaderData, Form } from "react-router";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { getDb } from "@promo/db";
import { offers, widgets, widgetPlacements } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, widgetRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(widgets).where(eq(widgets.offerId, offerId)),
  ]);

  return {
    offer: offerRows[0],
    widgets: widgetRows,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "add_widget") {
    const widgetType = formData.get("widgetType") as string;
    const title = formData.get("widgetTitle") as string;
    const subtitle = formData.get("widgetSubtitle") as string;
    const primaryColor = (formData.get("primaryColor") as string) || "#111111";
    const buttonText = (formData.get("buttonText") as string) || "Add to Cart";
    const placementType = formData.get("placementType") as string;

    const [newWidget] = await db.insert(widgets).values({
      shopId, offerId,
      type: widgetType as "gift_slider" | "gift_popup" | "cart_message" | "today_offer_widget" | "today_offer_block" | "progress_bar" | "gift_icon" | "gift_thumbnail" | "classic_bundle" | "mix_match_bundle" | "bundle_page" | "checkout_upsell" | "fbt" | "thank_you_upsell" | "volume_discount",
      internalName: `${widgetType}-${offerId.slice(0, 8)}`,
      title: title || null,
      subtitle: subtitle || null,
      config: {
        buttonText,
        maxSelectableCount: parseInt(formData.get("maxSelectable") as string, 10) || 1,
        layout: formData.get("layout") as string || "popup",
        showPrice: formData.get("showPrice") === "on",
        showOutOfStock: formData.get("showOutOfStock") === "on",
      },
      theme: {
        primaryColor,
        buttonColor: formData.get("buttonColor") as string || primaryColor,
        textColor: formData.get("textColor") as string || "#ffffff",
        backgroundColor: formData.get("backgroundColor") as string || "#ffffff",
      },
      isEnabled: true,
    }).returning({ id: widgets.id });

    if (newWidget && placementType) {
      await db.insert(widgetPlacements).values({
        shopId, widgetId: newWidget.id,
        placementType,
        selector: formData.get("cssSelector") as string || null,
        pageRule: {
          pageType: formData.get("pageType") as string || "all",
          urlPattern: formData.get("urlPattern") as string || undefined,
        },
        sortOrder: 0, isEnabled: true,
      });
    }
  }

  if (intent === "toggle_widget") {
    const widgetId = formData.get("widgetId") as string;
    const isEnabled = formData.get("isEnabled") === "true";
    await db.update(widgets).set({ isEnabled: !isEnabled }).where(eq(widgets.id, widgetId));
  }

  if (intent === "delete_widget") {
    const widgetId = formData.get("widgetId") as string;
    await db.delete(widgets).where(eq(widgets.id, widgetId));
  }

  return null;
};

const WIDGET_TYPE_OPTIONS = [
  { label: "Gift Slider", value: "gift_slider" },
  { label: "Progress Bar", value: "progress_bar" },
  { label: "Today Offer Widget", value: "today_offer_widget" },
  { label: "Today Offer Block", value: "today_offer_block" },
];

const PLACEMENT_TYPE_OPTIONS = [
  { label: "Cart Drawer", value: "cart_drawer" },
  { label: "Cart Page", value: "cart_page" },
  { label: "Product Page", value: "product_page" },
  { label: "Global", value: "global" },
];

const WIDGET_TYPE_LABELS: Record<string, string> = {
  gift_slider: "Gift Slider",
  progress_bar: "Progress Bar",
  today_offer_widget: "Today Offer Widget",
  today_offer_block: "Today Offer Block",
  cart_message: "Cart Message",
  gift_icon: "Gift Icon",
  gift_thumbnail: "Gift Thumbnail",
  classic_bundle: "Classic Bundle Block",
  mix_match_bundle: "Mix & Match Block",
  fbt: "Frequently Bought Together",
  volume_discount: "Volume Discount Block",
};

export default function OfferWidgetPage() {
  const { offer, widgets: existingWidgets } = useLoaderData<typeof loader>();
  const [adding, setAdding] = useState(false);
  const [widgetType, setWidgetType] = useState("gift_slider");
  const [placementType, setPlacementType] = useState("cart_drawer");
  const [primaryColor, setPrimaryColor] = useState("#111111");

  if (!offer) return <NotFound message="Offer not found." />;

  return (
    <div className="b-page">
      {/* ── Header ── */}
      <PageHeader title="Widget Settings" subtitle={offer.internalName} backTo={`/app/offers/${offer.id}`} />

      {/* ── Body layout ── */}
      <div className="b-editor-layout">
        {/* ── Main column ── */}
        <div className="b-editor-main">

          {/* Existing widgets */}
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Configured Widgets</h2>
            <div className="b-editor-section-body">
              {existingWidgets.length === 0 ? (
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  No widgets configured. Add a widget below to display this offer to customers.
                </p>
              ) : (
                <div className="b-stack b-stack-3">
                  {existingWidgets.map((w) => (
                    <div
                      key={w.id}
                      className="b-card"
                      style={{ boxShadow: "none" }}
                    >
                      <div
                        className="b-card-body"
                        style={{ padding: "14px 16px" }}
                      >
                        <div className="b-row-between">
                          <div className="b-row b-gap-3">
                            <span className="b-badge b-badge-blue">
                              {WIDGET_TYPE_LABELS[w.type] ?? w.type}
                            </span>
                            <span className="b-text-sm b-text-bold">
                              {w.title ?? w.internalName}
                            </span>
                          </div>
                          <div className="b-row b-gap-2">
                            {/* Toggle enable/disable */}
                            <Form method="POST" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                              <input type="hidden" name="intent" value="toggle_widget" />
                              <input type="hidden" name="widgetId" value={w.id} />
                              <input type="hidden" name="isEnabled" value={String(w.isEnabled)} />
                              <label className="b-toggle" title={w.isEnabled ? "Disable" : "Enable"}>
                                <input
                                  type="checkbox"
                                  defaultChecked={w.isEnabled ?? false}
                                  onChange={(e) => {
                                    (e.target.closest("form") as HTMLFormElement)?.requestSubmit();
                                  }}
                                />
                                <span className="b-toggle-track" />
                                <span className="b-toggle-thumb" />
                              </label>
                            </Form>
                            {/* Remove */}
                            <Form method="POST" style={{ display: "inline-flex" }}>
                              <input type="hidden" name="intent" value="delete_widget" />
                              <input type="hidden" name="widgetId" value={w.id} />
                              <button
                                type="submit"
                                className="b-btn-icon b-btn-icon-red"
                                title="Remove widget"
                              >
                                ✕
                              </button>
                            </Form>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add Widget toggle */}
              {!adding && (
                <div style={{ marginTop: existingWidgets.length > 0 ? 16 : 0 }}>
                  <button
                    type="button"
                    className="b-btn b-btn-secondary"
                    onClick={() => setAdding(true)}
                  >
                    + Add Widget
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Add Widget collapsible form */}
          {adding && (
            <div className="b-editor-section">
              <h2 className="b-editor-section-title">Add Widget</h2>
              <div className="b-editor-section-body">
                <Form method="POST">
                  <input type="hidden" name="intent" value="add_widget" />

                  <div className="b-stack b-stack-4">
                    {/* Widget type */}
                    <div>
                      <label className="b-label" htmlFor="widgetType">Widget Type</label>
                      <select
                        id="widgetType"
                        name="widgetType"
                        className="b-select"
                        value={widgetType}
                        onChange={(e) => setWidgetType(e.target.value)}
                      >
                        {WIDGET_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Title + subtitle */}
                    <div className="b-grid-2">
                      <div>
                        <label className="b-label" htmlFor="widgetTitle">Title</label>
                        <input
                          id="widgetTitle"
                          name="widgetTitle"
                          className="b-input"
                          type="text"
                          placeholder="Your Free Gift"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="widgetSubtitle">Subtitle</label>
                        <input
                          id="widgetSubtitle"
                          name="widgetSubtitle"
                          className="b-input"
                          type="text"
                          placeholder="Optional subtitle"
                          autoComplete="off"
                        />
                      </div>
                    </div>

                    {/* Primary color */}
                    <div>
                      <label className="b-label" htmlFor="primaryColor">Primary Color</label>
                      <div className="b-row b-gap-2">
                        <input
                          id="primaryColor"
                          name="primaryColor"
                          className="b-input"
                          type="text"
                          value={primaryColor}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          placeholder="#111111"
                          autoComplete="off"
                          style={{ flex: 1 }}
                        />
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: "var(--r-sm)",
                            background: primaryColor,
                            border: "1px solid var(--border)",
                            flexShrink: 0,
                          }}
                          title={primaryColor}
                        />
                        <input
                          type="color"
                          value={primaryColor.startsWith("#") && primaryColor.length === 7 ? primaryColor : "#111111"}
                          onChange={(e) => setPrimaryColor(e.target.value)}
                          style={{
                            width: 36,
                            height: 36,
                            padding: 2,
                            border: "1px solid var(--border)",
                            borderRadius: "var(--r-sm)",
                            cursor: "pointer",
                            flexShrink: 0,
                            background: "var(--bg-card)",
                          }}
                          title="Pick color"
                        />
                      </div>
                      <p className="b-help">Used for buttons and accents inside the widget.</p>
                    </div>

                    {/* Button text */}
                    <div>
                      <label className="b-label" htmlFor="buttonText">Button Text</label>
                      <input
                        id="buttonText"
                        name="buttonText"
                        className="b-input"
                        type="text"
                        defaultValue="Add to Cart"
                        autoComplete="off"
                      />
                    </div>

                    <hr className="b-divider" />

                    {/* Placement type */}
                    <div>
                      <label className="b-label" htmlFor="placementType">Placement</label>
                      <select
                        id="placementType"
                        name="placementType"
                        className="b-select"
                        value={placementType}
                        onChange={(e) => setPlacementType(e.target.value)}
                      >
                        {PLACEMENT_TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <p className="b-help">Where this widget will appear in the storefront.</p>
                    </div>

                    {/* Actions */}
                    <div className="b-row b-gap-2 b-mt-2">
                      <button type="submit" className="b-btn b-btn-primary">
                        Add Widget
                      </button>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary"
                        onClick={() => setAdding(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Form>
              </div>
            </div>
          )}
        </div>

        {/* ── Sidebar ── */}
        <div className="b-editor-sidebar">
          <div className="b-card">
            <div className="b-card-header">Widget Types</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">
                <div>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 2 }}>Gift Slider</p>
                  <p className="b-text-xs b-text-sub" style={{ margin: 0 }}>
                    A popup slider where customers pick their free gift. Best placed in the cart drawer or cart page.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 2 }}>Progress Bar</p>
                  <p className="b-text-xs b-text-sub" style={{ margin: 0 }}>
                    Shows cart progress toward the free gift threshold. Works on cart page, cart drawer, or globally.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 2 }}>Today Offer Widget</p>
                  <p className="b-text-xs b-text-sub" style={{ margin: 0 }}>
                    A floating site-wide widget that highlights the current promotion to every visitor.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 2 }}>Today Offer Block</p>
                  <p className="b-text-xs b-text-sub" style={{ margin: 0 }}>
                    An inline content block you can embed on product or collection pages via a theme app block.
                  </p>
                </div>
              </div>

              <hr className="b-divider" />

              <div className="b-banner" style={{ marginBottom: 0 }}>
                <span className="b-banner-icon">&#9432;</span>
                <div className="b-banner-body">
                  <p className="b-banner-title">Multiple widgets</p>
                  <p className="b-banner-text">
                    You can add more than one widget per offer to display it in multiple locations at once.
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
