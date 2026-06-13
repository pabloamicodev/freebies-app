/**
 * Upsell Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/upsell/checkout   → Checkout upsell
 *         /app/offers/new/upsell/fbt         → Frequently Bought Together
 *         /app/offers/new/upsell/thank-you   → Thank You page upsell
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";

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

const UPSELL_PAGE_TITLES: Record<string, string> = {
  "checkout": "Create Checkout upsell",
  "fbt": "Create upsell",
  "thank-you": "Create a thank-you page to boost sales",
};

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

// ─── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, db } = context;
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

  async function createOffer(candidateName: string) {
    const [offer] = await db
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
    return offer;
  }

  let newOffer: { id: string } | undefined;
  try {
    newOffer = await createOffer(internalName);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    newOffer = await createOffer(withUniqueOfferSuffix(internalName));
  }

  if (!newOffer) return { error: "Failed to create offer" };

  await Promise.all([
    db.insert(offerConditions).values({
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
    }),
    db.insert(offerRewards).values({
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
    }),
    db.insert(offerCombinationPolicies).values({
      shopId,
      offerId: newOffer.id,
      combinesWithOrderDiscounts: combinesOrderDiscounts,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: combinesShippingDiscounts,
      combinesWithOtherAppOffers: true,
      stopLowerPriority: false,
      giftValueCountsForOtherOffers: false,
    }),
  ]);

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Component ───────────────────────────────────────────────────────────────


export default function NewUpsellOfferPage() {
  const navigate = useNavigate();
  const { template: templateSlug = "checkout" } = useParams<{ template: string }>();

  const templateId = SLUG_TO_TEMPLATE[templateSlug] ?? "checkout";

  // ── State ────────────────────────────────────────────────────────────────
  const [formState, setFormField] = useObjectState(() => ({
    internalName: SLUG_DEFAULT_NAME[templateSlug] ?? "Upsell",
    publicTitle: "Frequently bought together",
    description: "",
    startsAt: new Date().toISOString().slice(0, 16),
    endsAt: "",
    triggerType: "always",
    upsellMethod: "manual",
    widgetType: "fbt",
    discountEnabled: false,
    discountMinProducts: "2",
    discountApplyTo: "any",
    discountType: "percentage",
    discountValue: "10",
    allowCustomerQty: false,
    checkoutTarget: "",
    upsellProducts: [] as string[],
    productPickerOpen: false,
    combinesOrderDiscounts: true,
    combinesShippingDiscounts: true,
    advancedOpen: false,
    infoBannerDismissed: false,
    fieldErrors: {} as { internalName?: string },
    showToast: false,
    toastMsg: "",
  }));
  const {
    internalName,
    publicTitle,
    description,
    startsAt,
    endsAt,
    triggerType,
    upsellMethod,
    widgetType,
    discountEnabled,
    discountMinProducts,
    discountApplyTo,
    discountType,
    discountValue,
    allowCustomerQty,
    checkoutTarget,
    upsellProducts,
    productPickerOpen,
    combinesOrderDiscounts,
    combinesShippingDiscounts,
    advancedOpen,
    infoBannerDismissed,
    fieldErrors,
    showToast,
    toastMsg,
  } = formState;
  const setInternalName = createFieldSetter(setFormField, "internalName");
  const setPublicTitle = createFieldSetter(setFormField, "publicTitle");
  const setDescription = createFieldSetter(setFormField, "description");
  const setStartsAt = createFieldSetter(setFormField, "startsAt");
  const setEndsAt = createFieldSetter(setFormField, "endsAt");
  const setTriggerType = createFieldSetter(setFormField, "triggerType");
  const setUpsellMethod = createFieldSetter(setFormField, "upsellMethod");
  const setWidgetType = createFieldSetter(setFormField, "widgetType");
  const setDiscountEnabled = createFieldSetter(setFormField, "discountEnabled");
  const setDiscountMinProducts = createFieldSetter(setFormField, "discountMinProducts");
  const setDiscountApplyTo = createFieldSetter(setFormField, "discountApplyTo");
  const setDiscountType = createFieldSetter(setFormField, "discountType");
  const setDiscountValue = createFieldSetter(setFormField, "discountValue");
  const setAllowCustomerQty = createFieldSetter(setFormField, "allowCustomerQty");
  const setCheckoutTarget = createFieldSetter(setFormField, "checkoutTarget");
  const setUpsellProducts = createFieldSetter(setFormField, "upsellProducts");
  const setProductPickerOpen = createFieldSetter(setFormField, "productPickerOpen");
  const setCombinesOrderDiscounts = createFieldSetter(setFormField, "combinesOrderDiscounts");
  const setCombinesShippingDiscounts = createFieldSetter(setFormField, "combinesShippingDiscounts");
  const setAdvancedOpen = createFieldSetter(setFormField, "advancedOpen");
  const setInfoBannerDismissed = createFieldSetter(setFormField, "infoBannerDismissed");
  const setFieldErrors = createFieldSetter(setFormField, "fieldErrors");
  const setShowToast = createFieldSetter(setFormField, "showToast");
  const setToastMsg = createFieldSetter(setFormField, "toastMsg");

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


  // ── Page title ───────────────────────────────────────────────────────────
  const pageTitle = UPSELL_PAGE_TITLES[templateSlug] ?? "Create upsell";

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
          <div className="rd-style-054">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>{pageTitle}</h1>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Configure your upsell offer</div>
          </div>
          <span className="rd-style-055">Upsell</span>
        </div>
      </div>

      {/* ── Info banner ── */}
      {!infoBannerDismissed && (
        <div className="rd-style-056">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              Quick tour: How to create an upsell
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              <button type="button" className="b-btn b-btn-plain" style={{ color: "var(--upsell-color)", textDecoration: "underline" }}>
                Get familiar with our tour or learn more in our onboarding guide.
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setInfoBannerDismissed(true)}
            className="rd-style-057"
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
                <div className="rd-style-058">1</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell information</span>
                <span className="rd-style-059">1</span>
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
                <div className="rd-style-058">2</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell trigger</span>
                <span className="rd-style-059">2</span>
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
              <div className="b-card-body rd-style-060">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Add sub-condition
              </div>
            </div>

            {/* ── Card: Upsell method ── */}
            <div className="b-card" style={{ borderTop: "3px solid var(--upsell-color)" }}>
              <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                <div className="rd-style-058">3</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Upsell method</span>
                <span className="rd-style-059">3</span>
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
                          className="rd-style-061" style={{ border: `2px solid ${widgetType === value ? "var(--upsell-color)" : "var(--border)"}`, background: widgetType === value ? "rgba(124,58,237,0.06)" : "var(--bg)", fontWeight: widgetType === value ? 600 : 400, color: widgetType === value ? "var(--upsell-color)" : "var(--text)" }}
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
                          className="rd-style-062" style={{ fontWeight: upsellMethod === m ? 600 : 400, color: upsellMethod === m ? "var(--upsell-color)" : "var(--text-sub)", borderBottom: upsellMethod === m ? "2px solid var(--upsell-color)" : "2px solid transparent", borderBottomColor: upsellMethod === m ? "var(--upsell-color)" : "transparent" }}
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
                          <label className="b-label" htmlFor="checkout-discount-type">Type:</label>
                          <select
                            id="checkout-discount-type"
                            aria-label="Checkout discount type"
                            className="b-select" name="discountType" value={discountType}
                            onChange={(e) => setDiscountType(e.target.value)}
                          >
                            <option value="percentage">Percentage</option>
                            <option value="fixed_amount">Fixed amount</option>
                          </select>
                        </div>
                        <div>
                          <label className="b-label" htmlFor="checkout-discount-value">Value:</label>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                              {discountType === "percentage" ? "%" : "$"}
                            </span>
                            <input
                              id="checkout-discount-value"
                              aria-label="Checkout discount value"
                              className="b-input" type="number" name="discountValue"
                              value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                              min="0" autoComplete="off"
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <button type="button" className="b-btn b-btn-plain" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                          + Add: Shipping discount
                        </button>
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
                  <label className="b-checkbox-row" htmlFor="fbt-discount-enabled" style={{ cursor: "pointer", gap: 10 }}>
                    <input
                      id="fbt-discount-enabled"
                      aria-label="Enable discount"
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
                          id="discountMinProducts" aria-label="Number of unique products required for discount" className="b-input" type="number"
                          name="discountMinProducts"
                          value={discountMinProducts}
                          onChange={(e) => setDiscountMinProducts(e.target.value)}
                          min="1" style={{ maxWidth: 120 }} autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="discountApplyTo">Apply discount to:</label>
                        <select
                          id="discountApplyTo" aria-label="Apply discount to" className="b-select" name="discountApplyTo"
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
                          <label className="b-label" htmlFor="fbt-discount-type">Type:</label>
                          <select
                            id="fbt-discount-type"
                            aria-label="Frequently bought together discount type"
                            className="b-select" name="discountType" value={discountType}
                            onChange={(e) => setDiscountType(e.target.value)}
                          >
                            <option value="percentage">Percentage</option>
                            <option value="fixed_amount">Fixed amount</option>
                          </select>
                        </div>
                        <div>
                          <label className="b-label" htmlFor="fbt-discount-value">Value:</label>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                              {discountType === "percentage" ? "%" : "$"}
                            </span>
                            <input
                              id="fbt-discount-value"
                              aria-label="Frequently bought together discount value"
                              className="b-input" type="number" name="discountValue"
                              value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                              min="0" autoComplete="off"
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <button type="button" className="b-btn b-btn-plain" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                          + Add: Shipping discount
                        </button>
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
                      <label className="b-label" htmlFor="thank-you-discount-type">Tipo:</label>
                      <select
                        id="thank-you-discount-type"
                        aria-label="Tipo de descuento"
                        className="b-select" name="discountType" value={discountType}
                        onChange={(e) => setDiscountType(e.target.value)}
                      >
                        <option value="percentage">Porcentaje</option>
                        <option value="fixed_amount">Monto fijo</option>
                      </select>
                    </div>
                    <div>
                      <label className="b-label" htmlFor="thank-you-discount-value">Valor:</label>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {discountType === "percentage" ? "%" : "$"}
                        </span>
                        <input
                          id="thank-you-discount-value"
                          aria-label="Valor del descuento"
                          className="b-input" type="number" name="discountValue"
                          value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                          min="0" autoComplete="off"
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <button type="button" className="b-btn b-btn-plain" style={{ fontSize: 13, color: "var(--upsell-color)", textDecoration: "none" }}>
                      + Add: Shipping discount
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Checkout/Thank-You: Configuración avanzada (collapsible) ── */}
            {(isCheckout || isThankYou) && (
              <div className="b-card">
                <button
                  type="button"
                  className="b-card-header rd-style-063"
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


        </div>

        {/* ── Footer ── */}
        <div className="rd-style-031">
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
