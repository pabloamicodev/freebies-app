/**
 * Per-market widget configuration page — linked from the widget settings tab.
 * GET  /app/offers/:id/widget/market
 * POST /app/offers/:id/widget/market  → save market overrides
 */

import { parseUuidParam } from "../lib/route-params.js";
import { useLoaderData, useActionData, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { parseJsonArray } from "../lib/offer-validation.server.js";
import { widgets } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { getMarketsForShop } from "../lib/markets.server.js";
import { loadMarketOverrides, setMarketOverrides } from "../lib/offer-widgets.server.js";
import { MarketWidgetConfig } from "../components/MarketWidgetConfig.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db, currencyCode: shopCurrencyCode } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  await loadOwnedOffer(db, shopId, offerId);

  const [offerWidgets, markets, marketOverrides] = await Promise.all([
    db.select().from(widgets).where(and(eq(widgets.offerId, offerId), eq(widgets.shopId, shopId))).limit(1),
    getMarketsForShop(shopId),
    loadMarketOverrides({ db, shopId }, offerId),
  ]);

  const widget = offerWidgets[0];

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
    shopCurrencyCode,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db, currencyCode, timezone } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const formData = await request.formData();
  await loadOwnedOffer(db, shopId, offerId);

  const overridesJson = formData.get("overrides") as string;
  const overridesForm = new FormData();
  overridesForm.set("overrides", overridesJson || "[]");
  const overridesResult = parseJsonArray(overridesForm, "overrides");
  if (overridesResult.error) return { error: overridesResult.error };

  const deps = { db, shopId, shopDomain: session.shop, shopCurrency: currencyCode, timezone };
  const result = await setMarketOverrides(deps, { offerId, overrides: overridesResult.data! }, { performedBy: session.shop });
  if (!result.ok) return { error: result.error };
  return { success: true, savedCount: result.value.savedCount };
};

async function saveMarketOverrides(overrides: Array<{ marketId: string; thresholdCents: number | null }>) {
  const form = new FormData();
  form.append("overrides", JSON.stringify(overrides));
  await fetch("", { method: "POST", body: form });
}

export default function WidgetMarketPage() {
  const { offerId, markets, marketOverrides, baseThresholdCents, widgetId, shopCurrencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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

      {actionData?.error && (
        <div className="b-banner b-banner-critical" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <p className="b-banner-text">{actionData.error}</p>
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
                    shopCurrencyCode={shopCurrencyCode}
                    markets={markets}
                    defaultOverrides={marketOverrides}
                    onSave={saveMarketOverrides}
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
