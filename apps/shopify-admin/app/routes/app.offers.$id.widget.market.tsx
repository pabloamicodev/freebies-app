/**
 * Per-market widget configuration page — linked from the widget settings tab.
 * GET  /app/offers/:id/widget/market
 * POST /app/offers/:id/widget/market  → save market overrides
 */

import { useLoaderData, useActionData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { widgets, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { getMarketsForShop } from "../lib/markets.server.js";
import { MarketWidgetConfig } from "../components/MarketWidgetConfig.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;

  const [offerWidgets, markets, marketOverrideRow] = await Promise.all([
    db.select().from(widgets).where(and(eq(widgets.offerId, offerId), eq(widgets.shopId, shopId))).limit(1),
    getMarketsForShop(shopId),
    db.select({ value: appSettings.value })
      .from(appSettings)
      .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, `widget.market_overrides.${offerId}`)))
      .limit(1),
  ]);

  const widget = offerWidgets[0];
  const marketOverrides = marketOverrideRow[0]?.value
    ? JSON.parse(marketOverrideRow[0].value)
    : [];

  // Get base threshold from widget config
  const widgetConfig = (widget?.config ?? {}) as Record<string, unknown>;
  const baseThresholdCents = widgetConfig["thresholdCents"] as number | undefined;

  return {
    offerId,
    shopId,
    widgetId: widget?.id ?? "",
    markets,
    marketOverrides,
    baseThresholdCents,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();

  const overridesJson = formData.get("overrides") as string;
  let overrides = [];
  try { overrides = JSON.parse(overridesJson); } catch {}

  await db.insert(appSettings)
    .values({ shopId, key: `widget.market_overrides.${offerId}`, value: JSON.stringify(overrides) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(overrides), updatedAt: new Date() },
    });

  return { success: true, savedCount: overrides.length };
};

export default function WidgetMarketPage() {
  const { offerId, markets, marketOverrides, baseThresholdCents, widgetId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  async function handleSave(overrides: Array<{ marketId: string; thresholdCents: number | null }>) {
    const form = new FormData();
    form.append("overrides", JSON.stringify(overrides));
    await fetch("", { method: "POST", body: form });
  }

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Market Widget Overrides" backTo={`/app/offers/${offerId}/widget`} />

      {/* Info banner */}
      <div className="b-banner">
        <div className="b-banner-icon">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5"/>
            <path d="M10 9v5M10 7h.01" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="b-banner-body">
          <p className="b-banner-text">Override widget appearance per Shopify Market</p>
        </div>
      </div>

      {/* Success banner */}
      {actionData?.success && (
        <div className="b-banner" style={{ borderColor: "#a7d9c8", background: "var(--green-bg)", marginBottom: 16 }}>
          <div className="b-banner-icon">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="9" stroke="#008060" strokeWidth="1.5"/>
              <path d="M6.5 10.5l2.5 2.5 4.5-5" stroke="#008060" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="b-banner-body">
            <p className="b-banner-text">{actionData.savedCount} market override(s) saved</p>
          </div>
        </div>
      )}

      {/* Form */}
      <Form method="post">
        <div className="b-stack b-stack-4">
          {markets.length === 0 ? (
            <div className="b-card">
              <div className="b-card-body">
                <div className="b-banner" style={{ marginBottom: 0 }}>
                  <div className="b-banner-icon">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                      <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5"/>
                      <path d="M10 9v5M10 7h.01" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <div className="b-banner-body">
                    <p className="b-banner-text">No Shopify Markets configured</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            markets.map((market) => (
              <div key={market.id} className="b-card">
                <div className="b-card-header">
                  <div className="b-row b-gap-3">
                    <span className="b-text-bold">{market.name}</span>
                    <span className="b-text-xs b-text-muted">{market.id}</span>
                  </div>
                </div>
                <div className="b-card-body">
                  <MarketWidgetConfig
                    widgetId={widgetId}
                    baseThresholdCents={baseThresholdCents}
                    defaultOverrides={marketOverrides}
                    onSave={handleSave}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        {markets.length > 0 && (
          <div className="b-mt-4" style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="b-btn b-btn-primary">
              Save Market Overrides
            </button>
          </div>
        )}
      </Form>
    </div>
  );
}
