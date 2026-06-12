/**
 * Upsell Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/upsell/checkout   → Checkout upsell
 *         /app/offers/new/upsell/fbt         → Frequently Bought Together
 *         /app/offers/new/upsell/thank-you   → Thank You page upsell
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";
import { OfferSummarySidebar } from "../components/OfferSummarySidebar.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// ─── Slug → internal template ID ─────────────────────────────────────────────

const SLUG_TO_TEMPLATE: Record<string, string> = {
  "checkout": "checkout",
  "fbt": "fbt",
  "thank-you": "thank_you",
};

// ─── Default internal names by slug ──────────────────────────────────────────

const SLUG_DEFAULT_NAME: Record<string, string> = {
  "checkout": "Checkout Upsell #1",
  "fbt": "Frequently Bought Together",
  "thank-you": "Thank You Upsell",
};

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();
  if (!shopId) return { error: "Shop not found" };

  const intent = formData.get("intent") as string;
  const internalName = (formData.get("internalName") as string)?.trim();
  const publicTitle = (formData.get("publicTitle") as string)?.trim() || internalName;
  const descriptionRaw = (formData.get("description") as string)?.trim();
  const description = descriptionRaw || undefined;
  const startsAt = formData.get("startsAt") as string;
  const endsAt = formData.get("endsAt") as string;

  const templateRaw = (formData.get("template") as string) || "checkout";
  const triggerType = (formData.get("triggerType") as string) || "always";
  const upsellMethod = (formData.get("upsellMethod") as string) || "manual";
  const widgetType = (formData.get("widgetType") as string) || "fbt";
  const discountEnabled = formData.get("discountEnabled") === "on";
  const discountMinProducts = parseInt(formData.get("discountMinProducts") as string || "2", 10) || 2;
  const discountApplyTo = (formData.get("discountApplyTo") as string) || "any";
  const discountType = (formData.get("discountType") as string) || "percentage";
  const discountValue = parseFloat(formData.get("discountValue") as string || "10");
  const allowCustomerQty = formData.get("allowCustomerQty") === "true";
  const checkoutTarget = (formData.get("checkoutTarget") as string) || null;
  const combinesOrderDiscounts = formData.get("combinesOrderDiscounts") !== "off";
  const combinesShippingDiscounts = formData.get("combinesShippingDiscounts") !== "off";

  const upsellProductsJson = (formData.get("upsellProducts") as string) || "[]";
  let upsellProducts: string[] = [];
  try { upsellProducts = JSON.parse(upsellProductsJson) as string[]; } catch {}

  if (!internalName) {
    return { error: "Internal name is required" };
  }

  const status: "active" | "draft" = intent === "publish" ? "active" : "draft";

  const rewardAmount =
    discountType === "percentage" ? discountValue
    : Math.round(discountValue * 100);

  let newOffer: { id: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateName = attempt === 0 ? internalName : `${internalName} (${attempt + 1})`;
    try {
      [newOffer] = await db
        .insert(offers)
        .values({
          shopId,
          type: "upsell",
          status,
          internalName: candidateName,
          publicTitle: publicTitle || candidateName,
          description,
          priority: 100,
          startsAt: startsAt ? new Date(startsAt) : new Date(),
          endsAt: endsAt ? new Date(endsAt) : null,
        })
        .returning({ id: offers.id });
      break;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }

  if (!newOffer) return { error: "Failed to create offer" };

  await db.insert(offerConditions).values({
    shopId,
    offerId: newOffer.id,
    scope: "visibility",
    conditionType: "sales_channels",
    operator: "eq",
    value: {
      upsellType: templateRaw,
      triggerType,
      upsellMethod,
      widgetType: templateRaw === "fbt" ? widgetType : undefined,
      checkoutTarget: templateRaw === "checkout" ? checkoutTarget : undefined,
      allowCustomerQty: templateRaw === "fbt" ? allowCustomerQty : undefined,
      discountEnabled: templateRaw === "fbt" ? discountEnabled : undefined,
      discountMinProducts: templateRaw === "fbt" ? discountMinProducts : undefined,
      discountApplyTo: templateRaw === "fbt" ? discountApplyTo : undefined,
    },
    sortOrder: 0,
    isEnabled: true,
  });

  await db.insert(offerRewards).values({
    shopId,
    offerId: newOffer.id,
    rewardType: "upsell_discount",
    discountType: discountType as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
    value: { amount: rewardAmount, currencyCode: "USD" },
    target: { variantIds: upsellProducts },
    isAutoAdd: false,
    isCustomerSelectable: true,
    trackMode: "product",
    sortOrder: 0,
  });

  await db.insert(offerCombinationPolicies).values({
    shopId,
    offerId: newOffer.id,
    combinesWithOrderDiscounts: combinesOrderDiscounts,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: combinesShippingDiscounts,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  });

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewUpsellOfferPage() {
  const navigate = useNavigate();
  const { template: templateSlug = "checkout" } = useParams<{ template: string }>();

  const templateId = SLUG_TO_TEMPLATE[templateSlug] ?? "checkout";

  // ── State ────────────────────────────────────────────────────────────────
  const [internalName, setInternalName] = useState(SLUG_DEFAULT_NAME[templateSlug] ?? "Upsell");
  const [publicTitle, setPublicTitle] = useState("Frequently bought together");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt] = useState("");

  const [triggerType, setTriggerType] = useState("always");
  const [upsellMethod, setUpsellMethod] = useState("manual");
  const [widgetType, setWidgetType] = useState("fbt");
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountMinProducts, setDiscountMinProducts] = useState("2");
  const [discountApplyTo, setDiscountApplyTo] = useState("any");
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("10");
  const [allowCustomerQty, setAllowCustomerQty] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState("");

  const [upsellProducts, setUpsellProducts] = useState<string[]>([]);
  const [productPickerOpen, setProductPickerOpen] = useState(false);

  const [combinesOrderDiscounts, setCombinesOrderDiscounts] = useState(true);
  const [combinesShippingDiscounts, setCombinesShippingDiscounts] = useState(true);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [infoBannerDismissed, setInfoBannerDismissed] = useState(false);

  // Validation
  const [fieldErrors, setFieldErrors] = useState<{ internalName?: string }>({});
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  function validate() {
    const errs: { internalName?: string } = {};
    if (!internalName.trim()) errs.internalName = "Nombre de venta adicional es requerido";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

  const hasName = Boolean(internalName.trim());
  const hasProducts = upsellProducts.length > 0;

  // ── Page title ───────────────────────────────────────────────────────────
  const PAGE_TITLE: Record<string, string> = {
    "checkout": "Create Checkout upsell",
    "fbt": "Create upsell",
    "thank-you": "Create a thank-you page to boost sales",
  };
  const pageTitle = PAGE_TITLE[templateSlug] ?? "Create upsell";

  // ── Helpers ──────────────────────────────────────────────────────────────
  const isCheckout = templateSlug === "checkout";
  const isFbt = templateSlug === "fbt";
  const isThankYou = templateSlug === "thank-you";

  return (
    <div className="b-page">

      {/* ── Header ── */}
      <div style={{ marginBottom: 28 }}>
        <button
          type="button"
          className="b-btn-plain b-text-sm"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 14 }}
          onClick={() => void navigate("/app/offers")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          All Offers
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 14, background: "var(--upsell-grad)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 4px 14px rgba(124,58,237,0.28)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>{pageTitle}</h1>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Configure your upsell offer</div>
          </div>
          <span style={{ marginLeft: "auto", background: "rgba(124,58,237,0.1)", color: "var(--upsell-color)", border: "1.5px solid rgba(124,58,237,0.2)", borderRadius: 20, fontSize: 11, fontWeight: 700, padding: "4px 12px", letterSpacing: "0.2px" }}>Upsell</span>
        </div>
      </div>

      {/* ── Info banner ── */}
      {!infoBannerDismissed && (
        <div style={{
          background: "var(--blue-bg, #e8f0fe)", border: "1px solid var(--blue-border, #b3cdf9)",
          borderRadius: 8, padding: "12px 16px", marginBottom: 20,
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              Quick tour: How to create an upsell
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              <a href="#" style={{ color: "var(--upsell-color)", textDecoration: "underline" }}>
                Get familiar with our tour or learn more in our onboarding guide.
              </a>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setInfoBannerDismissed(true)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1, color: "var(--text-sub)", padding: 0, flexShrink: 0 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        <input type="hidden" name="template" value={templateId} />
        <input type="hidden" name="triggerType" value={triggerType} />
        <input type="hidden" name="upsellMethod" value={upsellMethod} />
        <input type="hidden" name="widgetType" value={widgetType} />
        <input type="hidden" name="allowCustomerQty" value={String(allowCustomerQty)} />
        <input type="hidden" name="upsellProducts" value={JSON.stringify(upsellProducts)} />
        <input type="hidden" name="combinesOrderDiscounts" value={combinesOrderDiscounts ? "on" : "off"} />
        <input type="hidden" name="combinesShippingDiscounts" value={combinesShippingDiscounts ? "on" : "off"} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20, alignItems: "start" }}>

          {/* ── Left column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ── Card: Información de venta adicional ── */}
            <div className="b-card" style={{ borderTop: "3px solid var(--upsell-color)" }}>
              <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--upsell-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>1</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell information</span>
                <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(124,58,237,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>1</span>
              </div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Upsell name</label>
                  <input
                    id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                    value={internalName} onChange={(e) => setInternalName(e.target.value)}
                    autoComplete="off" placeholder="e.g., Checkout Upsell #1"
                  />
                  <div className="b-help">Internal use only, not shown to customers.</div>
                </div>

                {/* FBT-only: widget display fields */}
                {isFbt && (
                  <div className="b-card" style={{ background: "var(--bg-hover, #f9f9f9)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Upsell title</label>
                        <input
                          id="publicTitle" className="b-input" name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" placeholder="e.g., Frequently bought together"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Upsell description <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(optional)</span></label>
                        <input
                          id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder=""
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label className="b-label" htmlFor="startsAt">Start time</label>
                    <input
                      id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                      value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="endsAt">End time</label>
                    <input
                      id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                      value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Card: Upsell trigger ── */}
            <div className="b-card" style={{ borderTop: "3px solid var(--upsell-color)" }}>
              <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--upsell-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>2</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell trigger</span>
                <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(124,58,237,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>2</span>
              </div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {isFbt ? (
                  <>
                    {[
                      { value: "always", label: "Always show upsells" },
                      { value: "product_selected", label: "Selected products" },
                      { value: "product_except", label: "All except selected products" },
                      { value: "collection_selected", label: "Selected collections/types/vendors" },
                      { value: "collection_except", label: "All except selected collections/types/vendors" },
                    ].map(({ value, label }) => (
                      <label key={value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="radio" name="_triggerTypeRadio" value={value}
                          checked={triggerType === value}
                          onChange={() => setTriggerType(value)}
                          style={{ accentColor: "var(--upsell-color)", width: 15, height: 15 }}
                        />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
                      </label>
                    ))}
                    <div className="b-help" style={{ marginTop: 4 }}>
                      The upsell always shows without any trigger.
                    </div>
                  </>
                ) : (
                  <>
                    {[
                      { value: "always", label: "Always show upsells" },
                      { value: "cart", label: "Cart trigger" },
                      { value: "product", label: "Specific product trigger" },
                      { value: "customer", label: "Customer trigger" },
                    ].map(({ value, label }) => (
                      <label key={value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="radio" name="_triggerTypeRadio" value={value}
                          checked={triggerType === value}
                          onChange={() => setTriggerType(value)}
                          style={{ accentColor: "var(--upsell-color)", width: 15, height: 15 }}
                        />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
                      </label>
                    ))}
                    <div className="b-help" style={{ marginTop: 4 }}>
                      The upsell always shows without any trigger.
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Agregar subcondición (dashed) ── */}
            <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
              <div className="b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", color: "var(--upsell-color)", cursor: "pointer", fontWeight: 500, fontSize: 14 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Add sub-condition
              </div>
            </div>

            {/* ── Card: Upsell method ── */}
            <div className="b-card" style={{ borderTop: "3px solid var(--upsell-color)" }}>
              <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--upsell-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>3</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell method</span>
                <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(124,58,237,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>3</span>
              </div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* FBT: Widget type selector */}
                {isFbt && (
                  <div>
                    <div className="b-label" style={{ marginBottom: 8 }}>Upsell widget type</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {[
                        { value: "fbt", label: "Frequently bought together" },
                        { value: "product_add_on", label: "Product add-on" },
                      ].map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setWidgetType(value)}
                          style={{
                            border: `2px solid ${widgetType === value ? "var(--upsell-color)" : "var(--border)"}`,
                            borderRadius: 8, padding: "14px 12px", background: widgetType === value ? "rgba(124,58,237,0.06)" : "var(--bg)",
                            cursor: "pointer", textAlign: "center", fontSize: 13,
                            fontWeight: widgetType === value ? 600 : 400,
                            color: widgetType === value ? "var(--upsell-color)" : "var(--text)",
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Method tabs: Manual | Auto | (Aleatorio for fbt/thank-you) */}
                <div>
                  <div className="b-label" style={{ marginBottom: 8 }}>Select method</div>
                  <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
                    {["manual", "auto", ...(isCheckout ? [] : ["random"])].map((m) => {
                      const labels: Record<string, string> = { manual: "Manual", auto: "Auto", random: "Random" };
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setUpsellMethod(m)}
                          style={{
                            padding: "8px 16px", fontSize: 13,
                            fontWeight: upsellMethod === m ? 600 : 400,
                            color: upsellMethod === m ? "var(--upsell-color)" : "var(--text-sub)",
                            borderBottom: upsellMethod === m ? "2px solid var(--upsell-color)" : "2px solid transparent",
                            background: "none", border: "none",
                            borderBottomWidth: 2, borderBottomStyle: "solid",
                            borderBottomColor: upsellMethod === m ? "var(--upsell-color)" : "transparent",
                            cursor: "pointer",
                          }}
                        >
                          {labels[m]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Product selection */}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
                    Select upsell product
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button" className="b-btn b-btn-secondary"
                      onClick={() => setProductPickerOpen(true)}
                    >
                      Select products
                    </button>
                    <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                      {upsellProducts.length} products selected
                    </span>
                  </div>

                  {/* Checkout: limited qty checkbox */}
                  {isCheckout && (
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginTop: 10 }}>
                      <input type="checkbox" />
                      <div>
                        <div className="b-checkbox-label">A limited number of upsell products can be added.</div>
                      </div>
                    </label>
                  )}

                  {/* FBT: set qty for current item */}
                  {isFbt && (
                    <>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginTop: 10 }}>
                        <input type="checkbox" />
                        <div className="b-checkbox-label">Set quantity for current item</div>
                      </label>
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                          Upsell product quantity:
                        </div>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 6 }}>
                          <input
                            type="radio" name="_allowCustomerQtyRadio"
                            checked={allowCustomerQty}
                            onChange={() => setAllowCustomerQty(true)}
                            style={{ accentColor: "var(--upsell-color)", width: 15, height: 15 }}
                          />
                          <div>
                            <div className="b-checkbox-label">Allow customers to change quantity</div>
                            <div className="b-checkbox-help">Customers can adjust the quantity before adding to cart.</div>
                          </div>
                        </label>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input
                            type="radio" name="_allowCustomerQtyRadio"
                            checked={!allowCustomerQty}
                            onChange={() => setAllowCustomerQty(false)}
                            style={{ accentColor: "var(--upsell-color)", width: 15, height: 15 }}
                          />
                          <div>
                            <div className="b-checkbox-label">Fixed quantity</div>
                            <div className="b-checkbox-help">The quantity is fixed and cannot be changed by the customer.</div>
                          </div>
                        </label>
                      </div>
                    </>
                  )}
                </div>

                {/* Checkout: Discount section (inside method card) */}
                {isCheckout && (
                  <div className="b-card" style={{ background: "var(--bg-hover, #f9f9f9)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Discount</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label">Type:</label>
                          <select
                            className="b-select" name="discountType" value={discountType}
                            onChange={(e) => setDiscountType(e.target.value)}
                          >
                            <option value="percentage">Percentage</option>
                            <option value="fixed_amount">Fixed amount</option>
                          </select>
                        </div>
                        <div>
                          <label className="b-label">Value:</label>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                              {discountType === "percentage" ? "%" : "$"}
                            </span>
                            <input
                              className="b-input" type="number" name="discountValue"
                              value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                              min="0" autoComplete="off"
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <a href="#" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                          + Add: Shipping discount
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── FBT: Discount card (standalone) ── */}
            {isFbt && (
              <div className="b-card">
                <div className="b-card-header">Discount</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                    <input
                      type="checkbox" name="discountEnabled"
                      checked={discountEnabled}
                      onChange={(e) => setDiscountEnabled(e.target.checked)}
                    />
                    <div className="b-checkbox-label">Enable discount</div>
                  </label>

                  {discountEnabled && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="discountMinProducts">
                          Number of unique products required for discount
                        </label>
                        <input
                          id="discountMinProducts" className="b-input" type="number"
                          name="discountMinProducts"
                          value={discountMinProducts}
                          onChange={(e) => setDiscountMinProducts(e.target.value)}
                          min="1" style={{ maxWidth: 120 }} autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="discountApplyTo">Apply discount to:</label>
                        <select
                          id="discountApplyTo" className="b-select" name="discountApplyTo"
                          value={discountApplyTo}
                          onChange={(e) => setDiscountApplyTo(e.target.value)}
                        >
                          <option value="any">Any item</option>
                          <option value="cheapest">Cheapest item</option>
                          <option value="most_expensive">Most expensive item</option>
                        </select>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label">Type:</label>
                          <select
                            className="b-select" name="discountType" value={discountType}
                            onChange={(e) => setDiscountType(e.target.value)}
                          >
                            <option value="percentage">Percentage</option>
                            <option value="fixed_amount">Fixed amount</option>
                          </select>
                        </div>
                        <div>
                          <label className="b-label">Value:</label>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                              {discountType === "percentage" ? "%" : "$"}
                            </span>
                            <input
                              className="b-input" type="number" name="discountValue"
                              value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                              min="0" autoComplete="off"
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <a href="#" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                          + Add: Shipping discount
                        </a>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Thank You: Discount card ── */}
            {isThankYou && (
              <div className="b-card">
                <div className="b-card-header">Discount</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label">Tipo:</label>
                      <select
                        className="b-select" name="discountType" value={discountType}
                        onChange={(e) => setDiscountType(e.target.value)}
                      >
                        <option value="percentage">Porcentaje</option>
                        <option value="fixed_amount">Monto fijo</option>
                      </select>
                    </div>
                    <div>
                      <label className="b-label">Valor:</label>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {discountType === "percentage" ? "%" : "$"}
                        </span>
                        <input
                          className="b-input" type="number" name="discountValue"
                          value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                          min="0" autoComplete="off"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <a href="#" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                      + Add: Shipping discount
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* ── Checkout/Thank-You: Configuración avanzada (collapsible) ── */}
            {(isCheckout || isThankYou) && (
              <div className="b-card">
                <button
                  type="button"
                  className="b-card-header"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: "none", border: "none", cursor: "pointer", padding: "12px 16px", textAlign: "left" }}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                >
                  <span>Advanced settings (optional)</span>
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {advancedOpen && (
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {/* Discount code */}
                    <div className="b-card" style={{ background: "var(--bg-hover, #f9f9f9)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Discount code</div>
                      <div className="b-card-body">
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="checkbox" />
                          <div>
                            <div className="b-checkbox-label">Add a custom discount code</div>
                            <div className="b-checkbox-help">Customers can enter a discount code at checkout.</div>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Combinations */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
                        This upsell discount can be combined with
                      </div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 8 }}>
                        <input
                          type="checkbox"
                          checked={combinesOrderDiscounts}
                          onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                        />
                        <div className="b-checkbox-label">Order discounts</div>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={combinesShippingDiscounts}
                          onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                        />
                        <div className="b-checkbox-label">Shipping discounts</div>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── FBT: Discount code + combinations ── */}
            {isFbt && (
              <>
                <div className="b-card">
                  <div className="b-card-header">Discount code</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" />
                      <div>
                        <div className="b-checkbox-label">Add a custom discount code</div>
                        <div className="b-checkbox-help">Customers can enter a discount code at checkout.</div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="b-card">
                  <div className="b-card-header">This upsell discount can be combined with</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                      />
                      <div className="b-checkbox-label">Order discounts</div>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                      />
                      <div className="b-checkbox-label">Shipping discounts</div>
                    </label>
                  </div>
                </div>
              </>
            )}

            {/* Checkout target (hidden field, shown as select for checkout) */}
            {isCheckout && (
              <div className="b-card">
                <div className="b-card-header">Checkout surface</div>
                <div className="b-card-body">
                  <label className="b-label" htmlFor="checkoutTarget">Checkout target</label>
                  <select
                    id="checkoutTarget" className="b-select" name="checkoutTarget"
                    value={checkoutTarget}
                    onChange={(e) => setCheckoutTarget(e.target.value)}
                  >
                    <option value="">Select surface</option>
                    <option value="checkout">Checkout</option>
                    <option value="post_purchase">Post-purchase</option>
                    <option value="cart">Cart</option>
                  </select>
                </div>
              </div>
            )}

          </div>

          {/* ── Right column ── */}
          <OfferSummarySidebar
            accentColor="var(--upsell-color)"
            helpCard={null}
            aboveSummary={isFbt ? (
              <div className="b-card">
                <div className="b-card-header">Preview</div>
                <div className="b-card-body">
                  <div style={{
                    border: "1px solid var(--border)", borderRadius: 8, padding: 16,
                    background: "var(--bg-hover, #f9f9f9)", minHeight: 160,
                    display: "flex", flexDirection: "column", gap: 10,
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      {publicTitle || "Frequently bought together"}
                    </div>
                    {description && (
                      <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{description}</div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      {upsellProducts.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-sub)", fontStyle: "italic" }}>
                          Select products to see a preview
                        </div>
                      ) : (
                        upsellProducts.slice(0, 3).map((id) => (
                          <div key={id} style={{
                            width: 52, height: 52, background: "var(--border)", borderRadius: 6,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 10, color: "var(--text-sub)",
                          }}>
                            img
                          </div>
                        ))
                      )}
                    </div>
                    {discountEnabled && (
                      <div style={{ fontSize: 12, color: "var(--upsell-color)", fontWeight: 500 }}>
                        {discountType === "percentage" ? `${discountValue}% OFF` : `$${discountValue} OFF`}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : undefined}
            steps={[
              {
                label: "Basic information",
                checked: hasName,
                items: hasName ? [
                  { text: internalName },
                  { text: `Starts ${new Date(startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` },
                ] : undefined,
              },
              {
                label: "Upsell trigger",
                checked: true,
                items: [{ text: triggerType === "always" ? "No trigger / Always show" : triggerType }],
              },
              {
                label: "Upsell method",
                checked: hasProducts,
                items: hasProducts ? [{ text: `${upsellProducts.length} product(s) selected` }] : undefined,
              },
            ]}
          />

        </div>

        {/* ── Footer ── */}
        <div style={{ position: "sticky", bottom: 0, zIndex: 10, display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, padding: "14px 0", background: "rgba(250,249,247,0.9)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderTop: "1px solid var(--border)" }}>
          <button
            type="button" className="b-btn b-btn-secondary"
            onClick={() => void navigate("/app/offers")}
          >
            Cancel
          </button>
          <button
            type="submit" name="intent" value="draft" className="b-btn b-btn-secondary"
          >
            Save draft
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-primary" style={{ background: "var(--upsell-grad)", boxShadow: "0 4px 12px rgba(124,58,237,0.3)" }}>
            Publish offer
          </button>
        </div>

      </Form>

      <ProductPicker
        open={productPickerOpen}
        onClose={() => setProductPickerOpen(false)}
        title="Select upsell products"
        allowMultiple
        selectedIds={upsellProducts}
        onSelect={(gids) => setUpsellProducts(gids)}
      />

      {showToast && (
        <Toast message={toastMsg} type="error" onDismiss={() => setShowToast(false)} />
      )}
    </div>
  );
}

