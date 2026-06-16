/**
 * Multi-Currency Configuration — configure per-currency thresholds and
 * fixed discount amounts for each active Shopify Market.
 *
 * Accessible from the offer detail page → "Multi-Currency" tab.
 */

import { useLoaderData, Form, useActionData, useNavigation } from "react-router";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { offers, offerConditions } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const conditionRows = await db.select().from(offerConditions).where(
    and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value"))
  ).limit(1);

  // Fetch markets from Shopify Admin API
  let markets: Array<{ id: string; name: string; currencyCode: string; handle: string }> = [];
  try {
    const marketsRes = await admin.graphql(`
      query {
        markets(first: 20) {
          nodes { id name handle currencySettings { baseCurrency { currencyCode } } }
        }
      }
    `);
    const marketsData = await marketsRes.json() as unknown;
    const marketsNodes = (marketsData as { data?: { markets?: { nodes?: Array<{ id: string; name: string; handle: string; currencySettings: { baseCurrency: { currencyCode: string } } }> } } }).data?.markets?.nodes;
    markets = marketsNodes?.map((m) => ({
      id: m.id,
      name: m.name,
      handle: m.handle,
      currencyCode: m.currencySettings.baseCurrency.currencyCode,
    })) ?? [];
  } catch {
    // Markets API unavailable
  }

  const condition = conditionRows[0];
  const existingValue = (condition?.value ?? {}) as Record<string, unknown>;
  const currencyOverrides = (existingValue["currencyOverrides"] ?? {}) as Record<string, number>;

  return {
    offer,
    offerId,
    markets,
    currencyOverrides,
    baseThresholdCents: (existingValue["thresholdCents"] as number) ?? 0,
    baseCurrency: (existingValue["currencyCode"] as string) ?? "USD",
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  await loadOwnedOffer(db, shopId, offerId);

  // Build currency overrides from form
  const overrides: Record<string, number> = {};
  const currencies = formData.getAll("currency[]") as string[];
  const thresholds = formData.getAll("threshold_cents[]") as string[];
  const fixedAmounts = formData.getAll("fixed_amount[]") as string[];

  for (let i = 0; i < currencies.length; i++) {
    const currency = currencies[i]?.toUpperCase();
    const raw = parseFloat(thresholds[i] ?? "0");
    const cents = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 0;
    if (currency && cents > 0) {
      overrides[currency] = cents;
    }
  }

  // Build fixed amount overrides
  const fixedOverrides: Record<string, number> = {};
  for (let i = 0; i < currencies.length; i++) {
    const currency = currencies[i]?.toUpperCase();
    const raw = parseFloat(fixedAmounts[i] ?? "0");
    const fixed = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 0;
    if (currency && fixed > 0) {
      fixedOverrides[currency] = fixed;
    }
  }

  let updateResult: { success: boolean } | { error: string } = { success: true };

  await db.transaction(async (tx) => {
    const existing = await tx.select()
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value")))
      .limit(1);

    if (!existing[0]) {
      updateResult = { error: "No cart value condition found. Add a Cart Value condition on the Conditions page first." };
      return;
    }

    const currentValue = existing[0].value as Record<string, unknown>;
    await tx.update(offerConditions)
      .set({ value: { ...currentValue, currencyOverrides: overrides, fixedAmountOverrides: fixedOverrides }, updatedAt: new Date() })
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, existing[0].id)));
  });

  return updateResult;
};

export default function MultiCurrencyPage() {
  const { offer, markets, currencyOverrides, baseThresholdCents, baseCurrency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  if (!offer) return <NotFound message="Offer not found." />;

  const baseThreshold = baseThresholdCents / 100;

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Multi-Currency" subtitle={offer.internalName} backTo={`/app/offers/${offer.id}`} />

      {/* Action feedback */}
      {actionData && "error" in actionData && actionData.error && (
        <div className="b-banner b-banner-red b-mb-4">
          <span className="b-banner-icon">✕</span>
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
          </div>
        </div>
      )}
      {actionData && "success" in actionData && actionData.success && (
        <div className="b-banner b-banner-green b-mb-4">
          <span className="b-banner-icon">✓</span>
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>Currency overrides saved.</p>
          </div>
        </div>
      )}

      {/* Info Banner */}
      <div className="b-banner">
        <div className="b-banner-icon">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5" />
            <path d="M10 9v5" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="6.5" r="0.75" fill="#2c6ecb" />
          </svg>
        </div>
        <div className="b-banner-body">
          <p className="b-banner-text">
            Set per-currency thresholds to match local purchasing power. Leave a field empty to fall back to the auto-converted base threshold ({baseCurrency} {baseThreshold.toFixed(2)}).
          </p>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="b-editor-layout">
        {/* Main — currency overrides form */}
        <div className="b-editor-main">
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Currency Overrides</h2>
            <div className="b-editor-section-body">
              <Form method="POST">
                <div className="b-table-wrap">
                  <table className="b-table">
                    <thead>
                      <tr>
                        <th style={{ width: "auto", paddingLeft: 16 }}>Currency</th>
                        <th>Threshold Override</th>
                        <th>Fixed Amount Override</th>
                      </tr>
                    </thead>
                    <tbody>
                      {markets.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ textAlign: "center", padding: "24px 16px" }}>
                            <span className="b-text-sub b-text-sm">
                              No markets configured. Add Shopify Markets in your store settings.
                            </span>
                          </td>
                        </tr>
                      ) : (
                        markets.map((market) => {
                          const existingThreshold = currencyOverrides[market.currencyCode]
                            ? (currencyOverrides[market.currencyCode]! / 100).toFixed(2)
                            : "";
                          return (
                            <tr key={market.id}>
                              <td style={{ paddingLeft: 16 }}>
                                <input type="hidden" name="currency[]" value={market.currencyCode} />
                                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  <span className="b-text-bold">{market.name}</span>
                                  <span className="b-badge b-badge-blue" style={{ alignSelf: "flex-start" }}>
                                    {market.currencyCode}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <label
                                    className="b-label"
                                    htmlFor={`threshold-${market.currencyCode}`}
                                  >
                                    {market.currencyCode} amount
                                  </label>
                                  <input
                                    id={`threshold-${market.currencyCode}`}
                                    aria-label={`${market.currencyCode} amount`}
                                    className="b-input"
                                    type="number"
                                    name="threshold_cents[]"
                                    defaultValue={existingThreshold}
                                    placeholder={`Auto (${baseCurrency} ${baseThreshold.toFixed(2)})`}
                                    min="0"
                                    step="0.01"
                                    autoComplete="off"
                                    style={{ maxWidth: 200 }}
                                  />
                                </div>
                              </td>
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <label
                                    className="b-label"
                                    htmlFor={`fixed-${market.currencyCode}`}
                                  >
                                    Fixed {market.currencyCode}
                                  </label>
                                  <input
                                    id={`fixed-${market.currencyCode}`}
                                    aria-label={`Fixed ${market.currencyCode}`}
                                    className="b-input"
                                    type="number"
                                    name="fixed_amount[]"
                                    defaultValue=""
                                    placeholder="Optional"
                                    min="0"
                                    step="0.01"
                                    autoComplete="off"
                                    style={{ maxWidth: 200 }}
                                  />
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="b-editor-footer">
                  <button
                    type="submit"
                    className="b-btn b-btn-primary"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "Saving…" : "Save Overrides"}
                  </button>
                </div>
              </Form>
            </div>
          </div>
        </div>

        {/* Sidebar — info card */}
        <div className="b-editor-sidebar">
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">How it works</h2>
            <div className="b-editor-section-body">
              <div className="b-stack b-stack-3">
                <div>
                  <p className="b-label">Threshold override</p>
                  <p className="b-text-sm b-text-sub">
                    Replace the auto-converted cart value threshold for a specific currency. Useful when local purchasing power differs significantly from your base currency.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div>
                  <p className="b-label">Fixed amount override</p>
                  <p className="b-text-sm b-text-sub">
                    Override the discount amount (e.g. shipping discount or gift value) for buyers in this currency. Leave blank to use the base-currency amount converted at checkout.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div>
                  <p className="b-label">Fallback behaviour</p>
                  <p className="b-text-sm b-text-sub">
                    Any currency without an override inherits the base threshold of{" "}
                    <strong>{baseCurrency} {baseThreshold.toFixed(2)}</strong>, converted by Shopify's exchange rate at the time of checkout.
                  </p>
                </div>
                <hr className="b-divider" style={{ margin: "4px 0" }} />
                <div className="b-banner" style={{ margin: 0 }}>
                  <div className="b-banner-icon">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="10" cy="10" r="9" stroke="#2c6ecb" strokeWidth="1.5" />
                      <path d="M10 9v5" stroke="#2c6ecb" strokeWidth="1.5" strokeLinecap="round" />
                      <circle cx="10" cy="6.5" r="0.75" fill="#2c6ecb" />
                    </svg>
                  </div>
                  <div className="b-banner-body">
                    <p className="b-banner-text">
                      Markets are pulled live from your Shopify Markets configuration. Add or remove markets in your Shopify admin to update this list.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
