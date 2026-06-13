/**
 * Offer Preview / Debug panel.
 * Allows the merchant to simulate a cart + customer scenario
 * and see exactly why an offer qualifies or doesn't.
 */

import { useLoaderData, Form, useActionData } from "react-router";
import { BackButton } from "../components/BackButton.js";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { evaluate } from "@promo/rule-engine";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import type { EvaluationInput } from "@promo/shared-types";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  return { offer: { id: offer.id, internalName: offer.internalName, type: offer.type } };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const cartValueUsd = parseFloat(formData.get("cartTotal") as string) || 0;
  const cartQty = parseInt(formData.get("cartQty") as string, 10) || 1;
  const customerTags = (formData.get("customerTags") as string).split(",").map((t) => t.trim()).filter(Boolean);
  const salesChannel = (formData.get("salesChannel") as string) || "online_store";
  const marketId = (formData.get("marketId") as string) || null;
  const currencyCode = (formData.get("currencyCode") as string) || "USD";

  // Load offer definitions
  const [conditionRows, rewardRows, policyRows] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
  ]);

  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) return { error: "Offer not found" };

  const offerDef = {
    id: offer.id,
    version: 1,
    type: offer.type,
    priority: offer.priority,
    stopLowerPriority: policyRows[0]?.stopLowerPriority ?? false,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    conditions: conditionRows.map((c) => ({
      id: c.id,
      scope: c.scope,
      conditionType: c.conditionType,
      operator: c.operator,
      value: c.value,
      isEnabled: c.isEnabled,
      sortOrder: c.sortOrder,
    })),
    rewards: rewardRows.map((r) => ({
      id: r.id,
      rewardType: r.rewardType,
      discountType: r.discountType,
      value: r.value,
      target: r.target,
      quantity: r.quantity,
      isAutoAdd: r.isAutoAdd,
      isCustomerSelectable: r.isCustomerSelectable,
      trackMode: r.trackMode as "product" | "variant",
      sortOrder: r.sortOrder,
      label: r.label,
    })),
    combinationPolicy: {
      combinesWithOrderDiscounts: policyRows[0]?.combinesWithOrderDiscounts ?? true,
      combinesWithProductDiscounts: policyRows[0]?.combinesWithProductDiscounts ?? true,
      combinesWithShippingDiscounts: policyRows[0]?.combinesWithShippingDiscounts ?? true,
      stopLowerPriority: policyRows[0]?.stopLowerPriority ?? false,
      maxApplicationsPerCart: policyRows[0]?.maxApplicationsPerCart ?? null,
      maxApplicationsPerCustomer: policyRows[0]?.maxApplicationsPerCustomer ?? null,
    },
    giftValueCountsForOtherOffers: policyRows[0]?.giftValueCountsForOtherOffers ?? false,
  };

  const simulatedInput: EvaluationInput = {
    shopDomain: session.shop,
    cart: {
      token: "preview-session",
      id: null,
      lines: [
        {
          key: "preview-line-1",
          variantId: "gid://shopify/ProductVariant/preview",
          productId: "gid://shopify/Product/preview",
          quantity: cartQty,
          priceCents: Math.round(cartValueUsd * 100),
          compareAtPriceCents: null,
          properties: {},
          requiresSellingPlan: false,
          sellingPlanId: null,
          productHandle: "preview-product",
          productTitle: "Simulated Product",
          variantTitle: null,
          vendor: "Preview Vendor",
          productType: "apparel",
          tags: [],
          collections: [],
          availableForSale: true,
          inventoryPolicy: "DENY",
          inventoryQuantity: 100,
        },
      ],
      subtotalCents: Math.round(cartValueUsd * 100),
      discountCodes: [],
      currencyCode,
      totalQuantity: cartQty,
    },
    customer: customerTags.length > 0
      ? {
          id: "preview-customer",
          email: "preview@example.com",
          tags: customerTags,
          totalSpentCents: 0,
          totalOrders: 1,
          lastOrderSpentCents: null,
          countryCode: null,
          isFirstTimeCustomer: false,
        }
      : null,
    market: marketId
      ? {
          id: marketId,
          handle: "preview-market",
          currencyCode,
          countryCode: null,
          primaryLocale: "en",
        }
      : null,
    locale: "en",
    salesChannel: salesChannel as "online_store" | "pos" | "mobile_app" | "headless",
    requestedUrl: null,
    sessionId: "preview-session",
  };

  const result = await evaluate(simulatedInput, {
    offers: [offerDef],
    oneUseStates: [],
    now: new Date(),
  });

  return { result, simulatedInput, conditionCount: conditionRows.length, rewardCount: rewardRows.length, offerStatus: offer.status };
};

export default function OfferPreviewPage() {
  const { offer } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const result = actionData && "result" in actionData ? actionData.result : null;
  const qualified = result?.qualifiedOffers.find((o) => o.offerId === offer.id);
  const disqualified = result?.disqualifiedOffers.find((o) => o.offerId === offer.id);
  const qualifies = !!qualified;

  const conditionCount = actionData && "conditionCount" in actionData ? actionData.conditionCount : null;
  const rewardCount = actionData && "rewardCount" in actionData ? actionData.rewardCount : null;
  const offerStatus = actionData && "offerStatus" in actionData ? actionData.offerStatus : null;
  const previewStatusText = result
    ? qualifies
      ? "Customer sees this offer"
      : "Offer hidden for this cart"
    : "Run a simulation to preview eligibility";

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div>
          <div className="b-page-title-row" style={{ marginBottom: 4 }}>
            <BackButton to={`/app/offers/${offer.id}`} />
            <h1 className="b-page-title">Preview &amp; Debug</h1>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-sub)" }}>{offer.internalName}</p>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, alignItems: "start" }}>
        {/* Left column */}
        <div className="b-stack b-stack-4">
          {/* Merchant-facing storefront preview */}
          <div className="b-card">
            <div className="b-card-header">Storefront Preview</div>
            <div className="b-card-body">
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-lg)",
                  background: "linear-gradient(180deg, #ffffff 0%, var(--bg-subtle) 100%)",
                  padding: 18,
                  boxShadow: "var(--shadow-xs)",
                }}
              >
                <div className="b-row-between" style={{ marginBottom: 12 }}>
                  <div>
                    <p className="b-text-xs b-text-sub" style={{ margin: 0 }}>Cart drawer widget</p>
                    <p style={{ margin: "2px 0 0", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                      {offer.internalName}
                    </p>
                  </div>
                  <span className={`b-badge ${qualifies ? "b-badge-green" : result ? "b-badge-orange" : "b-badge-gray"}`}>
                    {previewStatusText}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "13px 14px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r)",
                    background: qualifies ? "var(--green-bg)" : "var(--bg-card)",
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: "var(--r-sm)",
                      background: qualifies ? "var(--green)" : "var(--bg-hover)",
                      color: qualifies ? "#fff" : "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                    }}
                  >
                    {qualifies ? "✓" : "•"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      {qualifies ? "Free gift unlocked" : "Free gift locked"}
                    </p>
                    <p className="b-text-xs b-text-sub" style={{ margin: "2px 0 0" }}>
                      {qualifies
                        ? "The offer qualifies for the simulated cart and can be shown to the customer."
                        : result
                          ? "The simulated cart does not match the current offer conditions."
                          : "Enter cart values below to see how the offer behaves."}
                    </p>
                  </div>
                  <button type="button" className="b-btn b-btn-primary b-btn-sm" disabled={!qualifies}>
                    Add Gift
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Simulate Cart form card */}
          <div className="b-card">
            <div className="b-card-header">Simulate Cart</div>
            <div className="b-card-body">
              <Form method="POST">
                <div className="b-stack b-stack-3">
                  {/* Cart total */}
                  <div>
                    <label className="b-label" htmlFor="cartTotal">Cart total</label>
                    <div className="b-relative b-row" style={{ gap: 0 }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "7px 10px",
                          background: "var(--bg-hover)",
                          border: "1px solid #babec3",
                          borderRight: "none",
                          borderRadius: "var(--r-sm) 0 0 var(--r-sm)",
                          fontSize: 14,
                          color: "var(--text-sub)",
                          lineHeight: 1.25,
                        }}
                      >
                        $
                      </span>
                      <input
                        id="cartTotal"
                        className="b-input"
                        name="cartTotal"
                        type="number"
                        inputMode="decimal"
                        defaultValue="50"
                        min="0"
                        step="0.01"
                        style={{ borderRadius: "0 var(--r-sm) var(--r-sm) 0" }}
                      />
                    </div>
                    <p className="b-help">Total value of non-gift lines in cart</p>
                  </div>

                  {/* Cart quantity */}
                  <div>
                    <label className="b-label" htmlFor="cartQty">Cart item quantity</label>
                    <input
                      id="cartQty"
                      className="b-input"
                      name="cartQty"
                      type="number"
                      inputMode="numeric"
                      defaultValue="1"
                      min="1"
                    />
                  </div>

                  {/* Customer tags */}
                  <div>
                    <label className="b-label" htmlFor="customerTags">Customer tags</label>
                    <input
                      id="customerTags"
                      className="b-input"
                      name="customerTags"
                      type="text"
                      placeholder="vip, wholesale…"
                      defaultValue=""
                      autoComplete="off"
                    />
                    <p className="b-help">Comma-separated tags. Leave empty for guest.</p>
                  </div>

                  {/* Submit */}
                  <div style={{ paddingTop: 4 }}>
                    <button type="submit" className="b-btn b-btn-dark">
                      Run Simulation
                    </button>
                  </div>
                </div>
              </Form>
            </div>
          </div>

          {/* Results card */}
          {result && (
            <div className="b-card">
              <div className="b-card-header">Simulation Results</div>
              <div className="b-card-body">
                <div className="b-stack b-stack-3">
                  {/* Qualification banner */}
                  {qualifies ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "12px 16px",
                        borderRadius: "var(--r)",
                        background: "var(--green-bg)",
                        border: "1px solid #a7d9c8",
                      }}
                    >
                      <span style={{ fontSize: 18 }}>✓</span>
                      <span style={{ fontWeight: 600, color: "var(--green-txt)", fontSize: 14 }}>
                        Offer QUALIFIES
                      </span>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "12px 16px",
                        borderRadius: "var(--r)",
                        background: "var(--orange-badge)",
                        border: "1px solid #fcd34d",
                      }}
                    >
                      <span style={{ fontSize: 18 }}>✗</span>
                      <span style={{ fontWeight: 600, color: "var(--orange-txt)", fontSize: 14 }}>
                        Offer does NOT qualify
                      </span>
                    </div>
                  )}

                  {/* Reasons list */}
                  {(qualified ?? disqualified)?.reasons && (qualified ?? disqualified)!.reasons.length > 0 && (
                    <div>
                      <p className="b-label" style={{ marginBottom: 8 }}>Condition results</p>
                      <div className="b-stack b-stack-2">
                        {(qualified ?? disqualified)!.reasons.map((reason, i) => (
                          <div
                            key={i}
                            className="b-row b-gap-3"
                            style={{
                              padding: "10px 14px",
                              background: "var(--bg-hover)",
                              borderRadius: "var(--r-sm)",
                              border: "1px solid var(--border-light)",
                              alignItems: "flex-start",
                            }}
                          >
                            <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>
                              {reason.passed ? "✓" : "✗"}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p
                                style={{
                                  margin: 0,
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: reason.passed ? "var(--green-txt)" : "var(--orange-txt)",
                                }}
                              >
                                {reason.conditionType}
                              </p>
                              <p className="b-text-xs b-text-sub" style={{ margin: "2px 0 0" }}>
                                {reason.message}
                              </p>
                              {reason.actual !== undefined && (
                                <p className="b-text-xs b-text-muted" style={{ margin: "2px 0 0" }}>
                                  Actual: {JSON.stringify(reason.actual)} · Required: {JSON.stringify(reason.required)}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Applied gifts */}
                  {qualified && qualified.cartActions.length > 0 && (
                    <div>
                      <p className="b-label" style={{ marginBottom: 8 }}>Applied gifts</p>
                      <div className="b-stack b-stack-2">
                        {qualified.cartActions.map((cartAction, i) => (
                          <div
                            key={i}
                            style={{
                              padding: "10px 14px",
                              background: "var(--bg-hover)",
                              borderRadius: "var(--r-sm)",
                              border: "1px solid var(--border)",
                            }}
                          >
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                              {cartAction.action}
                            </p>
                            <pre
                              style={{
                                margin: "4px 0 0",
                                fontSize: 11,
                                color: "var(--text-muted)",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                                fontFamily: "monospace",
                              }}
                            >
                              {JSON.stringify(cartAction, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="b-card">
          <div className="b-card-header">Offer Summary</div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">
              {/* Offer name */}
              <div>
                <p className="b-text-xs b-text-sub" style={{ margin: "0 0 2px" }}>Offer name</p>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {offer.internalName}
                </p>
              </div>

              <hr className="b-divider" style={{ margin: "0" }} />

              {/* Condition count */}
              <div className="b-row-between">
                <span className="b-text-sm b-text-sub">Conditions</span>
                <span
                  className="b-badge b-badge-blue"
                  style={{ fontWeight: 600 }}
                >
                  {conditionCount ?? "—"}
                </span>
              </div>

              {/* Reward count */}
              <div className="b-row-between">
                <span className="b-text-sm b-text-sub">Rewards</span>
                <span
                  className="b-badge b-badge-blue"
                  style={{ fontWeight: 600 }}
                >
                  {rewardCount ?? "—"}
                </span>
              </div>

              <hr className="b-divider" style={{ margin: "0" }} />

              {/* Status badge */}
              <div className="b-row-between">
                <span className="b-text-sm b-text-sub">Status</span>
                {offerStatus ? (
                  offerStatus === "active" ? (
                    <span className="b-badge b-badge-green">{offerStatus}</span>
                  ) : offerStatus === "draft" ? (
                    <span className="b-badge b-badge-gray">{offerStatus}</span>
                  ) : (
                    <span className="b-badge b-badge-orange">{offerStatus}</span>
                  )
                ) : (
                  <span className="b-badge b-badge-gray">{offer.type}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
