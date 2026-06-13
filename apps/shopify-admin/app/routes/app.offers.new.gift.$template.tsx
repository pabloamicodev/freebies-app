/**
 * Gift Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/gift/bxgy  /bogo  /free-sample  /cart-value  /tiered  /scratch
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { SUPPORTED_CURRENCIES } from "@promo/shared-types";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";
import { SubconditionModal } from "../components/SubconditionModal.js";
import { SubconditionCard } from "../components/SubconditionCard.js";
import type { MainConditionType } from "../components/MainConditionModal.js";
import { MainConditionModal } from "../components/MainConditionModal.js";
import { SUB_FORMS } from "../components/subconditions/registry.js";
import { GIFT_SUBCONDITIONS } from "../components/subconditions/types.js";
import type { SubconditionId } from "../components/subconditions/types.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// ─── Slug → template ─────────────────────────────────────────────────────────
const SLUG_TO_TEMPLATE: Record<string, string> = {
  bxgy: "buy_x_get_y", bogo: "bogo", "free-sample": "buy_x_gift",
  "cart-value": "cart_value", tiered: "tiered", scratch: "scratch", custom: "scratch",
};

type ConditionType = "specific_product" | "cart_value" | "cart_quantity" | "cart_value_multiplier";

interface TemplatePreset {
  internalName: string; publicTitle: string;
  conditionType: ConditionType; label: string; giftsMatchProducts?: boolean;
}

const TEMPLATE_PRESETS: Record<string, TemplatePreset> = {
  cart_value:    { internalName: "Spend X amount to get gift",  publicTitle: "Spend X amount to get gift(s)", conditionType: "cart_value",             label: "Spend X to get gifts" },
  buy_x_gift:   { internalName: "Free sample with purchase",    publicTitle: "Free sample with purchase",     conditionType: "cart_quantity",           label: "Free sample with purchase" },
  bogo:         { internalName: "BOGO Buy 1 get 1 the same",   publicTitle: "BOGO (Buy 1 get 1 the same)",  conditionType: "specific_product",        label: "BOGO",          giftsMatchProducts: true },
  buy_x_get_y:  { internalName: "BXGY Buy X get Y",            publicTitle: "BXGY (Buy X get Y)",           conditionType: "specific_product",        label: "Buy X get Y",   giftsMatchProducts: false },
  tiered:       { internalName: "Spend more get more",          publicTitle: "Spend more get more",          conditionType: "cart_value_multiplier",   label: "Tiered spend with gifts" },
};

const CONDITION_TYPE_LABEL: Record<ConditionType, string> = {
  specific_product:       "Specific product condition",
  cart_value:             "Cart value condition",
  cart_quantity:          "Cart quantity condition",
  cart_value_multiplier:  "Tiered cart value condition",
};

const CURRENCIES = SUPPORTED_CURRENCIES;

// ─── Local icons (only used within this file) ─────────────────────────────────
function IChevDown() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>; }
function IChevUp()   { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>; }
function IInfo()     { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>; }

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

  const intent      = formData.get("intent") as string;
  const internalName = (formData.get("internalName") as string)?.trim();
  const publicTitle  = (formData.get("publicTitle") as string)?.trim();
  const startsAt    = formData.get("startsAt") as string;
  const endsAt      = formData.get("endsAt") as string;
  const priority    = parseInt(formData.get("priority") as string || "1", 10) || 1;

  if (!internalName || !publicTitle) return { error: "Internal name and public title are required" };

  const conditionType  = formData.get("conditionType") as ConditionType;
  const minAmount      = parseFloat(formData.get("minAmount") as string || "500");
  const maxAmount      = parseFloat(formData.get("maxAmount") as string || "0");
  const appliesTo      = (formData.get("appliesTo") as string) || "any_product";
  const minQty         = parseInt(formData.get("minQty") as string || "1", 10) || 1;
  const multiplyGifts  = formData.get("multiplyGifts") === "on";
  const giftsMatchProd = formData.get("giftsMatchProducts") === "on";
  const trackMode      = (formData.get("trackMode") as string) || "product";
  const condProductsJson = (formData.get("conditionProducts") as string) || "[]";
  let conditionProducts: string[] = [];
  try { conditionProducts = JSON.parse(condProductsJson) as string[]; } catch {}

  let conditionValue: Record<string, unknown>;
  if (conditionType === "specific_product") {
    conditionValue = { minQtyPerProduct: minQty, multiplyGifts, giftsMatchProducts: giftsMatchProd, trackMode, appliesTo: "specific_products", variantIds: conditionProducts };
  } else if (conditionType === "cart_quantity") {
    conditionValue = { minQuantity: minQty, appliesTo, includeGiftValues: false };
  } else {
    conditionValue = { thresholdCents: Math.round(minAmount * 100), maxAmountCents: Math.round(maxAmount * 100), appliesTo, includeGiftValues: false };
  }

  const discountType   = (formData.get("discountType") as string) || "percentage";
  const discountValue  = parseFloat(formData.get("discountValue") as string || "100");
  const giftCount      = parseInt(formData.get("giftCount") as string || "1", 10) || 1;
  const isAutoAdd      = formData.get("isAutoAdd") === "true";
  const rewardProductsJson = (formData.get("rewardProducts") as string) || "[]";
  let rewardProducts: string[] = [];
  try { rewardProducts = JSON.parse(rewardProductsJson) as string[]; } catch {}

  const rewardAmount = discountType === "free" ? 100 : discountType === "percentage" ? discountValue : Math.round(discountValue * 100);
  const status = intent === "publish" ? "active" : "draft";

  async function createOffer(candidateName: string) {
    const [offer] = await db.insert(offers).values({
      shopId, type: "gift", status,
      internalName: candidateName, publicTitle, priority,
      startsAt: startsAt ? new Date(startsAt) : new Date(),
      endsAt: endsAt ? new Date(endsAt) : null,
    }).returning({ id: offers.id });
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

  const subconditionsJson = (formData.get("subconditions") as string) || "{}";
  let subconditions: Record<string, Record<string, unknown>> = {};
  try { subconditions = JSON.parse(subconditionsJson) as Record<string, Record<string, unknown>>; } catch {}

  const validSubconditions = Object.entries(subconditions).filter(([, subVal]) =>
    subVal && Object.keys(subVal).length > 0,
  );

  await Promise.all([
    db.insert(offerConditions).values({ shopId, offerId: newOffer.id, scope: "main", conditionType, operator: "gte", value: conditionValue, sortOrder: 0, isEnabled: true }),
    ...validSubconditions.map(([subId, subVal], index) =>
      db.insert(offerConditions).values({ shopId, offerId: newOffer.id, scope: "sub", conditionType: subId, operator: "eq", value: subVal as Record<string, unknown>, sortOrder: index + 1, isEnabled: true }),
    ),
    db.insert(offerRewards).values({ shopId, offerId: newOffer.id, rewardType: "product_gift", discountType: discountType as "free" | "percentage" | "fixed_amount" | "fixed_price" | "cheapest_item_free" | "most_expensive_item_discount", value: { amount: rewardAmount, currencyCode: "USD" }, target: { scope: "cart", variantIds: rewardProducts }, quantity: giftCount, isAutoAdd, isCustomerSelectable: !isAutoAdd, trackMode: "product", sortOrder: 0 }),
    db.insert(offerCombinationPolicies).values({ shopId, offerId: newOffer.id, combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true, stopLowerPriority: false, giftValueCountsForOtherOffers: false }),
  ]);

  return redirect(`/app/offers/${newOffer.id}`);
};


// ─── Main Component ───────────────────────────────────────────────────────────
export default function NewGiftOfferPage() {
  const navigate = useNavigate();
  const { template: slug = "scratch" } = useParams<{ template: string }>();
  const templateId = SLUG_TO_TEMPLATE[slug] ?? "scratch";
  const preset = TEMPLATE_PRESETS[templateId];
  const isScratch = templateId === "scratch";
  // Scratch: sin condición predefinida ni preset
  const effectivePreset = isScratch ? null : preset;
  const conditionType: ConditionType = effectivePreset?.conditionType ?? "cart_value";

  const [formState, setFormField] = useObjectState(() => ({
    fieldErrors: {} as { internalName?: string; publicTitle?: string },
    showToast: false,
    toastMsg: "",
    internalName: preset?.internalName ?? "",
    publicTitle: preset?.publicTitle ?? "",
    startsAt: new Date().toISOString().slice(0, 16),
    endsAt: "",
    minAmount: "500",
    maxAmount: "0.00",
    selectedCurrencies: [] as string[],
    appliesTo: "any_product",
    minQty: 1,
    multiplyGifts: false,
    giftsMatchProducts: preset?.giftsMatchProducts ?? false,
    trackMode: "product",
    conditionProducts: [] as string[],
    condPickerOpen: false,
    subModalOpen: false,
    activeSubs: [] as SubconditionId[],
    subValues: {} as Record<string, unknown>,
    mainCondModalOpen: false,
    selectedMainCond: conditionType as MainConditionType,
    giftTab: "product" as "product" | "shipping",
    discountType: "percentage",
    discountValue: "100",
    isAutoAdd: false,
    giftCount: 1,
    rewardProducts: [] as string[],
    rewardPickerOpen: false,
    advancedOpen: false,
    priority: "1",
    stopLower: false,
    giftAppliesOther: false,
    addCartMessage: false,
    offerTodayTitle: "",
    addRedirectBtn: false,
  }));
  const {
    fieldErrors,
    showToast,
    toastMsg,
    internalName,
    publicTitle,
    startsAt,
    endsAt,
    minAmount,
    maxAmount,
    selectedCurrencies,
    appliesTo,
    minQty,
    multiplyGifts,
    giftsMatchProducts,
    trackMode,
    conditionProducts,
    condPickerOpen,
    subModalOpen,
    activeSubs,
    subValues,
    mainCondModalOpen,
    selectedMainCond,
    giftTab,
    discountType,
    discountValue,
    isAutoAdd,
    giftCount,
    rewardProducts,
    rewardPickerOpen,
    advancedOpen,
    priority,
    stopLower,
    giftAppliesOther,
    addCartMessage,
    offerTodayTitle,
    addRedirectBtn,
  } = formState;
  const setFieldErrors = createFieldSetter(setFormField, "fieldErrors");
  const setShowToast = createFieldSetter(setFormField, "showToast");
  const setToastMsg = createFieldSetter(setFormField, "toastMsg");
  const setInternalName = createFieldSetter(setFormField, "internalName");
  const setPublicTitle = createFieldSetter(setFormField, "publicTitle");
  const setStartsAt = createFieldSetter(setFormField, "startsAt");
  const setEndsAt = createFieldSetter(setFormField, "endsAt");
  const setMinAmount = createFieldSetter(setFormField, "minAmount");
  const setMaxAmount = createFieldSetter(setFormField, "maxAmount");
  const setSelectedCurrencies = createFieldSetter(setFormField, "selectedCurrencies");
  const setAppliesTo = createFieldSetter(setFormField, "appliesTo");
  const setMinQty = createFieldSetter(setFormField, "minQty");
  const setMultiplyGifts = createFieldSetter(setFormField, "multiplyGifts");
  const setGiftsMatchProducts = createFieldSetter(setFormField, "giftsMatchProducts");
  const setTrackMode = createFieldSetter(setFormField, "trackMode");
  const setConditionProducts = createFieldSetter(setFormField, "conditionProducts");
  const setCondPickerOpen = createFieldSetter(setFormField, "condPickerOpen");
  const setSubModalOpen = createFieldSetter(setFormField, "subModalOpen");
  const setActiveSubs = createFieldSetter(setFormField, "activeSubs");
  const setSubValues = createFieldSetter(setFormField, "subValues");
  const setMainCondModalOpen = createFieldSetter(setFormField, "mainCondModalOpen");
  const setSelectedMainCond = createFieldSetter(setFormField, "selectedMainCond");
  const setGiftTab = createFieldSetter(setFormField, "giftTab");
  const setDiscountType = createFieldSetter(setFormField, "discountType");
  const setDiscountValue = createFieldSetter(setFormField, "discountValue");
  const setIsAutoAdd = createFieldSetter(setFormField, "isAutoAdd");
  const setGiftCount = createFieldSetter(setFormField, "giftCount");
  const setRewardProducts = createFieldSetter(setFormField, "rewardProducts");
  const setRewardPickerOpen = createFieldSetter(setFormField, "rewardPickerOpen");
  const setAdvancedOpen = createFieldSetter(setFormField, "advancedOpen");
  const setPriority = createFieldSetter(setFormField, "priority");
  const setStopLower = createFieldSetter(setFormField, "stopLower");
  const setGiftAppliesOther = createFieldSetter(setFormField, "giftAppliesOther");
  const setAddCartMessage = createFieldSetter(setFormField, "addCartMessage");
  const setOfferTodayTitle = createFieldSetter(setFormField, "offerTodayTitle");
  const setAddRedirectBtn = createFieldSetter(setFormField, "addRedirectBtn");

  function validate() {
    const errs: { internalName?: string; publicTitle?: string } = {};
    if (!internalName.trim()) errs.internalName = "Offer name is required";
    if (!publicTitle.trim()) errs.publicTitle = "Public title is required";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

  const isBogo = templateId === "bogo"; // BOGO: auto-add disabled, gifts match by default

  function toggleCurrency(c: string) {
    setSelectedCurrencies((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  return (
    <div className="b-page">
      {/* ── Header ── */}
      <div style={{ marginBottom: 28 }}>
        <button type="button" className="b-btn-plain b-text-sm" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 14 }} onClick={() => void navigate("/app/offers")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          All Offers
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="rd-style-021">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>New Gift Offer</h1>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{preset?.label ?? "From scratch"}</div>
          </div>
          <span className="rd-style-022">Gift</span>
        </div>
      </div>

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        <input type="hidden" name="conditionType"      value={isScratch ? selectedMainCond : conditionType} />
        <input type="hidden" name="conditionProducts"  value={JSON.stringify(conditionProducts)} />
        <input type="hidden" name="rewardProducts"     value={JSON.stringify(rewardProducts)} />
        <input type="hidden" name="isAutoAdd"          value={String(isAutoAdd)} />
        <input type="hidden" name="minAmount"          value={minAmount} />
        <input type="hidden" name="maxAmount"          value={maxAmount} />
        <input type="hidden" name="appliesTo"          value={appliesTo} />
        <input type="hidden" name="priority"           value={priority} />
        <input type="hidden" name="subconditions"      value={JSON.stringify(subValues)} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start" }}>

          {/* ── Left column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ── Block 1: Offer information ── */}
            <div className="b-card" style={{ borderTop: "3px solid var(--gift-color)" }}>
              <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                <div className="rd-style-023">1</div>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Offer information</span>
                <span className="rd-style-024">1</span>
              </div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Offer name <span style={{ color: "var(--red, #e53e3e)" }}>*</span></label>
                  <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName" value={internalName}
                    onChange={(e) => { setInternalName(e.target.value); setFieldErrors((p) => ({ ...p, internalName: undefined })); }} autoComplete="off" />
                  {fieldErrors.internalName
                    ? <div className="b-help-error">{fieldErrors.internalName}</div>
                    : <div className="b-help">Internal only — not shown to customers.</div>
                  }
                </div>
                <div>
                  <label className="b-label" htmlFor="publicTitle">Public title <span style={{ color: "var(--red, #e53e3e)" }}>*</span></label>
                  <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle" value={publicTitle}
                    onChange={(e) => { setPublicTitle(e.target.value); setFieldErrors((p) => ({ ...p, publicTitle: undefined })); }} autoComplete="off" />
                  {fieldErrors.publicTitle
                    ? <div className="b-help-error">{fieldErrors.publicTitle}</div>
                    : <div className="b-help">Shown to customers in your online store.</div>
                  }
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label className="b-label" htmlFor="startsAt">Start time</label>
                    <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                      value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="endsAt">End time <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(optional)</span></label>
                    <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                      value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Block 2: Main condition ── */}
            {!isScratch && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div className="rd-style-023">2</div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Main condition</span>
              </div>

              <div className="b-card">
                <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>{CONDITION_TYPE_LABEL[conditionType]}</span>
                  <button type="button" className="b-modal-close" aria-label="Clear main condition" style={{ width: 24, height: 24, flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* cart_value */}
                  {conditionType === "cart_value" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="gift-min-amount">Min.</label>
                          <div style={{ position: "relative" }}>
                            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                            <input id="gift-min-amount" aria-label="Minimum amount" className="b-input" type="number" name="minAmount" value={minAmount}
                              onChange={(e) => setMinAmount(e.target.value)}
                              min="0" step="0.01" style={{ paddingLeft: 22 }} autoComplete="off" />
                          </div>
                        </div>
                        <div>
                          <label className="b-label" htmlFor="gift-max-amount">Max.</label>
                          <div style={{ position: "relative" }}>
                            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                            <input id="gift-max-amount" aria-label="Maximum amount" className="b-input" type="number" name="maxAmount" value={maxAmount}
                              onChange={(e) => setMaxAmount(e.target.value)}
                              min="0" step="0.01" style={{ paddingLeft: 22, paddingRight: 28 }} autoComplete="off" />
                            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--text-sub)" }}>%</span>
                          </div>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Currency filter</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {CURRENCIES.map((c) => (
                            <button key={c} type="button" onClick={() => toggleCurrency(c)} className="rd-style-025" style={{ border: `1.5px solid ${selectedCurrencies.includes(c) ? "var(--gift-color)" : "var(--border)"}`, background: selectedCurrencies.includes(c) ? "rgba(217,119,6,0.08)" : "var(--bg)", color: selectedCurrencies.includes(c) ? "var(--gift-color)" : "var(--text-sub)" }}>
                              {c}
                            </button>
                          ))}
                          <button type="button" className="rd-style-026">···</button>
                        </div>
                      </div>

                      <div>
                        <label className="b-label" htmlFor="gift-cart-value-applies-to">Condition applies to:</label>
                        <select id="gift-cart-value-applies-to" aria-label="Condition applies to" className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">any product</option>
                          <option value="exclude_variants_ids">all except selected products</option>
                          <option value="exclude_type_vendor_collection">all except selected types/vendors/collections</option>
                          <option value="specific_products">selected products</option>
                          <option value="type_vendor_collection">products in selected types/vendors/collections</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* cart_value_multiplier */}
                  {conditionType === "cart_value_multiplier" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="gift-base-multiplier-value">Base multiplier value</label>
                        <div style={{ position: "relative", maxWidth: 280 }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                          <input id="gift-base-multiplier-value" aria-label="Base multiplier value" className="b-input" type="number" name="minAmount" value={minAmount}
                            onChange={(e) => setMinAmount(e.target.value)}
                            min="0" step="0.01" style={{ paddingLeft: 22 }} autoComplete="off" placeholder="0.00" />
                        </div>
                        <div className="b-help">
                          Example: with base value $100, customers get 1 gift when cart exceeds $100, 2 gifts over $200, and so on.
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ color: "var(--text-sub)", display: "flex" }}>
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 5.275v-1.025c0-.69.56-1.25 1.25-1.25h4.5c.69 0 1.25.56 1.25 1.25v1.025c0 .448-.24.862-.63 1.085l-.43.246.866 3.894h.694c.69 0 1.25.56 1.25 1.25v1c0 .69-.56 1.25-1.25 1.25h-2.781l-.48 2.873a.75.75 0 0 1-1.479 0l-.479-2.873h-2.781c-.69 0-1.25-.56-1.25-1.25v-1c0-.69.56-1.25 1.25-1.25h.694l.866-3.894-.43-.246a1.25 1.25 0 0 1-.63-1.085Z"/></svg>
                        </span>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Currency filter</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {CURRENCIES.map((c) => (
                            <button key={c} type="button" onClick={() => toggleCurrency(c)} className="rd-style-025" style={{ border: `1.5px solid ${selectedCurrencies.includes(c) ? "var(--gift-color)" : "var(--border)"}`, background: selectedCurrencies.includes(c) ? "rgba(217,119,6,0.08)" : "var(--bg)", color: selectedCurrencies.includes(c) ? "var(--gift-color)" : "var(--text-sub)" }}>
                              {c}
                            </button>
                          ))}
                          <button type="button" className="rd-style-026">···</button>
                        </div>
                      </div>

                      <div>
                        <label className="b-label" htmlFor="gift-multiplier-applies-to">Condition applies to:</label>
                        <select id="gift-multiplier-applies-to" aria-label="Condition applies to" className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">any product</option>
                          <option value="exclude_variants_ids">all except selected products</option>
                          <option value="exclude_type_vendor_collection">all except selected types/vendors/collections</option>
                          <option value="specific_products">selected products</option>
                          <option value="type_vendor_collection">products in selected types/vendors/collections</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* cart_quantity */}
                  {conditionType === "cart_quantity" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="gift-min-qty">Min.</label>
                          <input id="gift-min-qty" aria-label="Minimum quantity" className="b-input" type="number" name="minQty" value={minQty}
                            onChange={(e) => setMinQty(parseInt(e.target.value) || 1)} min="1" autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="gift-max-qty">Max.</label>
                          <input id="gift-max-qty" aria-label="Maximum quantity" className="b-input" type="number" name="maxQty" autoComplete="off" placeholder="0" />
                        </div>
                      </div>
                      <div>
                        <label className="b-label" htmlFor="gift-quantity-applies-to">Condition applies to:</label>
                        <select id="gift-quantity-applies-to" aria-label="Condition applies to" className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">any product</option>
                          <option value="exclude_variants_ids">all except selected products</option>
                          <option value="exclude_type_vendor_collection">all except selected types/vendors/collections</option>
                          <option value="specific_products">selected products</option>
                          <option value="type_vendor_collection">products in selected types/vendors/collections</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* specific_product */}
                  {conditionType === "specific_product" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="gift-required-product-quantity">Required product quantity</label>
                        <input id="gift-required-product-quantity" aria-label="Required product quantity" className="b-input" type="number" name="minQty" value={minQty}
                          onChange={(e) => setMinQty(parseInt(e.target.value) || 1)}
                          min="1" style={{ maxWidth: 120 }} autoComplete="off" />
                      </div>
                      <label className="b-checkbox-row" htmlFor="gift-multiply-gifts" style={{ cursor: "pointer", gap: 10 }}>
                        <input id="gift-multiply-gifts" aria-label="Multiply gifts by product quantity" type="checkbox" name="multiplyGifts" checked={multiplyGifts} onChange={(e) => setMultiplyGifts(e.target.checked)} />
                        <div>
                          <div className="b-checkbox-label">Multiply gifts by product quantity</div>
                          <div className="b-checkbox-help">Customers get more gifts the more qualifying products they buy.</div>
                        </div>
                      </label>
                      <label className="b-checkbox-row" htmlFor="gift-match-products" style={{ cursor: "pointer", gap: 10 }}>
                        <input id="gift-match-products" aria-label="Gifts match the selected products" type="checkbox" name="giftsMatchProducts" checked={giftsMatchProducts} onChange={(e) => setGiftsMatchProducts(e.target.checked)} />
                        <div className="b-checkbox-label">Gifts match the selected products (BOGO).</div>
                      </label>
                      <div style={{ marginLeft: 26, display: "flex", flexDirection: "column", gap: 6 }}>
                        {[{ v: "variant", l: "Track by variant" }, { v: "product", l: "Track by product" }].map((opt) => (
                          <label key={opt.v} className="b-checkbox-row" htmlFor={`gift-track-${opt.v}`} style={{ cursor: giftsMatchProducts ? "pointer" : "not-allowed", gap: 8, opacity: giftsMatchProducts ? 1 : 0.5 }}>
                            <input id={`gift-track-${opt.v}`} aria-label={opt.l} type="radio" name="trackMode" value={opt.v} checked={trackMode === opt.v} disabled={!giftsMatchProducts}
                              onChange={() => setTrackMode(opt.v)} style={{ accentColor: "var(--gift-color)", width: 14, height: 14 }} />
                            <span style={{ fontSize: 13, color: giftsMatchProducts ? "var(--text)" : "var(--text-sub)" }}>{opt.l}</span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <label className="b-label" htmlFor="gift-specific-applies-to">Condition applies to:</label>
                        <select id="gift-specific-applies-to" aria-label="Condition applies to" className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="variants_ids">selected products</option>
                          <option value="type_vendor_collection">products in selected types/vendors/collections</option>
                        </select>
                      </div>
                      <div>
                        <button type="button" className="b-btn b-btn-secondary" onClick={() => setCondPickerOpen(true)}>Select products</button>
                        <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>{conditionProducts.length} selected products</span>
                      </div>
                    </>
                  )}

                </div>
              </div>

              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" className="b-btn b-btn-primary b-btn-sm" disabled>
                  + Add main condition
                </button>
                <div style={{ fontSize: 12, color: "var(--text-sub)" }}>
                  Cart quantity and cart value conditions can be combined
                </div>
              </div>
            </div>
            )}

            {/* Scratch: botón para abrir el modal de condición principal */}
            {isScratch && (
              <div className="b-card" style={{ borderTop: "3px solid var(--gift-color)" }}>
                <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                  <div className="rd-style-023">2</div>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Main condition</span>
                  <span className="rd-style-024">2</span>
                </div>
                <div className="b-card-body">
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button type="button" className="b-btn b-btn-primary b-btn-sm"
                      onClick={() => setMainCondModalOpen(true)}>
                      + Add main condition
                    </button>
                    <span style={{ fontSize: 12, color: "var(--text-sub)" }}>
                      Cart quantity and cart value conditions can be combined
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Block 3: Subconditions ── */}
            <div>
              {activeSubs.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <div className="rd-style-023">3</div>
                    <span style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Sub-conditions</span>
                  </div>
                  {activeSubs.map((id) => {
                    const SubForm = SUB_FORMS[id];
                    const def = GIFT_SUBCONDITIONS.find((s) => s.id === id)!;
                    return (
                      <SubconditionCard key={id} def={def} onRemove={() => {
                        setActiveSubs((prev) => prev.filter((x) => x !== id));
                        setSubValues((prev) => { const n = { ...prev }; delete n[id]; return n; });
                      }}>
                        <SubForm
                          value={subValues[id] as Record<string, unknown> | undefined}
                          onChange={(v) => setSubValues((prev) => ({ ...prev, [id]: v }))}
                        />
                      </SubconditionCard>
                    );
                  })}
                </div>
              )}

              <div className="b-card" style={{ background: "rgba(217,119,6,0.02)", border: "1.5px dashed rgba(217,119,6,0.3)" }}>
                <button type="button" className="b-card-body b-add-subcondition-trigger"
                  onClick={() => setSubModalOpen(true)}>
                  <div className="rd-style-027">+</div>
                  Add sub-condition
                </button>
              </div>

              {activeSubs.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-sub)" }}>
                  Sub-conditions combine additional filters like specific links, markets, customer location, etc. Sub-conditions are optional.
                </div>
              )}
            </div>

            {/* ── Block 4: Seleccionar regalos ── */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div className="rd-style-023">4</div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Gift reward</span>
              </div>
              <div className="b-card">
                {/* Tabs */}
                <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 16px" }}>
                  {[
                    { key: "product",  label: "Product Gift" },
                    { key: "shipping", label: "Free Shipping" },
                  ].map((tab) => (
                    <button key={tab.key} type="button" onClick={() => setGiftTab(tab.key as "product" | "shipping")}
                      className="rd-style-028" style={{ fontWeight: giftTab === tab.key ? 600 : 400, color: giftTab === tab.key ? "var(--gift-color)" : "var(--text-sub)", borderBottom: giftTab === tab.key ? "2px solid var(--gift-color)" : "2px solid transparent" }}>
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {giftTab === "product" && (
                    <>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Gift discount type</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <div>
                            <label className="b-label" htmlFor="gift-discount-type">Type:</label>
                            <select id="gift-discount-type" aria-label="Gift discount type" className="b-select" name="discountType" value={discountType} onChange={(e) => setDiscountType(e.target.value)}>
                              <option value="percentage">Percentage</option>
                              <option value="fixed_amount">Amount</option>
                              <option value="fixed_price">Fixed price</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label" htmlFor="gift-discount-value">Value:</label>
                            <div style={{ position: "relative" }}>
                              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>
                                {discountType === "fixed_amount" ? "$" : "%"}
                              </span>
                              <input id="gift-discount-value" aria-label="Gift discount value" className="b-input" type="number" name="discountValue" value={discountValue}
                                onChange={(e) => setDiscountValue(e.target.value)}
                                min="0" style={{ paddingLeft: 22 }} autoComplete="off" />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Customer will receive:</div>
                        <label className="b-checkbox-row" htmlFor="gift-auto-add-all" style={{ cursor: isBogo ? "not-allowed" : "pointer", gap: 10, marginBottom: 6, opacity: isBogo ? 0.5 : 1 }}>
                          <input id="gift-auto-add-all" aria-label="Automatically add all gifts" type="radio" name="_autoAddRadio" checked={isAutoAdd} disabled={isBogo}
                            onChange={() => setIsAutoAdd(true)}
                            style={{ accentColor: "var(--gift-color)", width: 15, height: 15 }} />
                          <span style={{ fontSize: 13, color: isBogo ? "var(--text-sub)" : "var(--text)" }}>Automatically add all gifts</span>
                        </label>
                        <label className="b-checkbox-row" htmlFor="gift-customer-selects" style={{ cursor: "pointer", gap: 10 }}>
                          <input id="gift-customer-selects" aria-label="Customer selects number of gifts" type="radio" name="_autoAddRadio" checked={!isAutoAdd} onChange={() => setIsAutoAdd(false)}
                            style={{ accentColor: "var(--gift-color)", width: 15, height: 15 }} />
                          <span style={{ fontSize: 13, color: "var(--text)" }}>Customer selects number of gifts</span>
                        </label>
                        {!isAutoAdd && (
                          <input aria-label="Gift count" className="b-input" type="number" name="giftCount" value={giftCount}
                            onChange={(e) => setGiftCount(parseInt(e.target.value) || 1)}
                            min="1" style={{ maxWidth: 80, marginTop: 8 }} autoComplete="off" />
                        )}
                        {isAutoAdd && <input type="hidden" name="giftCount" value="1" />}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary" onClick={() => setRewardPickerOpen(true)}>
                          Select gifts
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>{rewardProducts.length} selected products</span>
                      </div>
                    </>
                  )}

                  {giftTab === "shipping" && (
                    <div style={{ textAlign: "center", padding: "24px 0", color: "var(--text-sub)", fontSize: 13 }}>
                      Free shipping as gift — coming soon
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Block 5: Configuración avanzada ── */}
            <div className="b-card">
              <button type="button" className="b-card-header rd-style-029"
                onClick={() => setAdvancedOpen((v) => !v)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div className="rd-style-030">5</div>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Advanced settings</span>
                  <span style={{ color: "var(--text-sub)", display: "flex" }}><IInfo /></span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--border-light)", padding: "1px 6px", borderRadius: 100, border: "1px solid var(--border)" }}>optional</span>
                </div>
                <span style={{ color: "var(--text-sub)", display: "flex" }}>{advancedOpen ? <IChevUp /> : <IChevDown />}</span>
              </button>

              {advancedOpen && (
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {/* Funciona con otras ofertas */}
                  <div style={{ position: "relative" }}>
                    <div style={{ position: "absolute", top: 0, right: 0, zIndex: 1 }}>
                      <img src="data:image/svg+xml,%3csvg%20width='36'%20height='36'%20viewBox='0%200%2036%2036'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='%23FFAA00'/%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='url(%23paint0_linear_30409_40096)'%20fill-opacity='0.5'/%3e%3cpath%20d='M28.8775%2014.8774C28.8593%2013.9095%2028.481%2012.947%2027.7424%2012.2085L27.3396%2011.8057L25.8059%2013.3395L26.2087%2013.7422C26.8763%2014.4099%2026.8763%2015.492%2026.2088%2016.1596C25.5412%2016.8271%2024.459%2016.8272%2023.7913%2016.1596C23.1237%2015.4919%2023.1238%2014.4099%2023.7914%2013.7422L27.7425%209.79118C28.41%209.12371%2029.4922%209.12366%2030.1597%209.79118C30.8272%2010.4587%2030.8273%2011.541%2030.1598%2012.2085L31.6936%2013.7422C33.2082%2012.2277%2033.2081%209.77202%2031.6935%208.25743C31.2597%207.82368%2030.7489%207.51414%2030.2049%207.32882C29.7756%207.18258%2029.3261%207.11358%2028.8777%207.12222C28.8861%206.67385%2028.8172%206.22419%2028.6711%205.79503C28.4858%205.25118%2028.1762%204.74017%2027.7424%204.30632C26.2278%202.79173%2023.7722%202.79173%2022.2576%204.30632C21.8238%204.74017%2021.5143%205.25123%2021.3289%205.79502C21.1827%206.22428%2021.1138%206.67389%2021.1224%207.12232C20.674%207.11367%2020.2244%207.18258%2019.7951%207.32882C19.2513%207.51409%2018.7403%207.82362%2018.3065%208.25743C16.792%209.77201%2016.7919%2012.2277%2018.3064%2013.7422C18.7403%2014.1761%2019.2513%2014.4856%2019.7951%2014.6709C20.2243%2014.817%2020.6739%2014.8859%2021.1224%2014.8775C21.1138%2015.3259%2021.1827%2015.7755%2021.3289%2016.2047C21.5142%2016.7488%2021.8238%2017.2596%2022.2575%2017.6933C23.7721%2019.2079%2026.2279%2019.2079%2027.7425%2017.6934C28.1762%2017.2596%2028.4857%2016.7485%2028.6711%2016.2047C28.8173%2015.7755%2028.8861%2015.3257%2028.8775%2014.8774ZM22.2577%2012.2085C21.5901%2012.8761%2020.5079%2012.8761%2019.8403%2012.2085C19.1727%2011.5409%2019.1728%2010.4588%2019.8404%209.79118C20.508%209.12356%2021.5901%209.12365%2022.2576%209.79118L23.4663%2010.9999L22.2577%2012.2085ZM25.0001%209.46614L23.7913%208.25743C23.1239%207.58996%2023.1238%206.50774%2023.7914%205.84012C24.4591%205.1725%2025.5411%205.1726%2026.2087%205.84012C26.8762%206.50764%2026.8763%207.58991%2026.2088%208.25743L25.0001%209.46614Z'%20fill='white'/%3e%3cpath%20d='M21.1225%207.12289C21.1407%208.09071%2021.519%209.0532%2022.2576%209.79175L22.6604%2010.1945L24.1941%208.66079L23.7913%208.258C23.1237%207.59038%2023.1237%206.50822%2023.7912%205.84069C24.4588%205.17317%2025.541%205.17307%2026.2087%205.84069C26.8763%206.50832%2026.8762%207.59038%2026.2086%208.258L22.2575%2012.2091C21.59%2012.8765%2020.5078%2012.8766%2019.8403%2012.2091C19.1728%2011.5415%2019.1727%2010.4593%2019.8402%209.79175L18.3064%208.258C16.7918%209.77259%2016.7919%2012.2282%2018.3065%2013.7428C18.7403%2014.1766%2019.2511%2014.4861%2019.7951%2014.6714C20.2244%2014.8177%2020.6739%2014.8867%2021.1223%2014.878C21.1139%2015.3264%2021.1828%2015.7761%2021.3289%2016.2052C21.5142%2016.7491%2021.8238%2017.2601%2022.2576%2017.6939C23.7722%2019.2085%2026.2278%2019.2085%2027.7424%2017.6939C28.1762%2017.2601%2028.4857%2016.749%2028.6711%2016.2052C28.8173%2015.776%2028.8862%2015.3264%2028.8776%2014.8779C29.326%2014.8866%2029.7756%2014.8177%2030.2049%2014.6714C30.7487%2014.4862%2031.2597%2014.1766%2031.6935%2013.7428C33.208%2012.2282%2033.2081%209.77259%2031.6936%208.25801C31.2597%207.82415%2030.7487%207.51462%2030.2049%207.3293C29.7757%207.1832%2029.3261%207.1143%2028.8776%207.12279C28.8862%206.67437%2028.8173%206.22476%2028.6711%205.7955C28.4858%205.25145%2028.1762%204.74065%2027.7424%204.30689C26.2279%202.79231%2023.7721%202.79231%2022.2575%204.30689C21.8238%204.74065%2021.5143%205.2517%2021.3289%205.7955C21.1827%206.22476%2021.1139%206.67452%2021.1225%207.12289ZM27.7423%209.79175C28.4099%209.12413%2029.4921%209.12413%2030.1597%209.79175C30.8273%2010.4594%2030.8272%2011.5414%2030.1596%2012.2091C29.492%2012.8767%2028.4099%2012.8766%2027.7424%2012.2091L26.5337%2011.0004L27.7423%209.79175ZM24.9999%2012.5341L26.2087%2013.7428C26.8761%2014.4103%2026.8762%2015.4925%2026.2086%2016.1601C25.5409%2016.8277%2024.4589%2016.8276%2023.7913%2016.1601C23.1238%2015.4926%2023.1237%2014.4103%2023.7912%2013.7428L24.9999%2012.5341Z'%20fill='white'/%3e%3cdefs%3e%3clinearGradient%20id='paint0_linear_30409_40096'%20x1='18'%20y1='0'%20x2='18'%20y2='36'%20gradientUnits='userSpaceOnUse'%3e%3cstop%20stop-color='white'%20stop-opacity='0'/%3e%3cstop%20offset='1'%20stop-color='white'/%3e%3c/linearGradient%3e%3c/defs%3e%3c/svg%3e" width="36" height="36" alt="feature-plan" />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Works with other offers</div>
                    <div>
                      <label className="b-label" htmlFor="priority">Priority</label>
                      <input id="priority" className="b-input" type="number" value={priority}
                        onChange={(e) => setPriority(e.target.value)} style={{ maxWidth: 120 }} autoComplete="off" />
                    </div>
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={stopLower} onChange={(e) => setStopLower(e.target.checked)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Stop lower priority</div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Offers with priority 2, 3,... will stop if customers meet this offer's conditions</div>
                        </div>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={giftAppliesOther} onChange={(e) => setGiftAppliesOther(e.target.checked)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Gift applies to other rules.</div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>The gift value will apply to other rules when the gift price is greater than 0.</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Mensaje del carrito */}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Cart message</div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8 }}>This is applied when offer is displayed on Cart page on your Online Store.</div>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" checked={addCartMessage} onChange={(e) => setAddCartMessage(e.target.checked)} />
                      <span style={{ fontSize: 13, color: "var(--text)" }}>Add a cart message</span>
                    </label>
                  </div>

                  {/* Oferta de hoy */}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Today's offer</span>
                      <span style={{ background: "#fef3c7", color: "#92400e", fontSize: 12, fontWeight: 600, padding: "2px 7px", borderRadius: 10, border: "1px solid #fbbf24" }}>legacy</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 10 }}>
                      The latest version of the Today offer is now available in Boosters. If you&apos;re still using this version, you can configure the display text and redirect link here.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label className="b-label" htmlFor="today-offer-title">Offer title</label>
                        <input id="today-offer-title" aria-label="Offer title" className="b-input" value={offerTodayTitle} onChange={(e) => setOfferTodayTitle(e.target.value)}
                          placeholder="Enter offer title" autoComplete="off" />
                        <div className="b-help">If blank, the original title will be used. Changing this won&apos;t affect the original offer title.</div>
                      </div>
                      <label className="b-checkbox-row" htmlFor="today-offer-add-redirect" style={{ cursor: "pointer", gap: 10 }}>
                        <input id="today-offer-add-redirect" aria-label="Add a redirect button" type="checkbox" checked={addRedirectBtn} onChange={(e) => setAddRedirectBtn(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Add a redirect button</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>


        </div>

        {/* ── Footer ── */}
        <div className="rd-style-031">
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary">
            Save draft
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-primary" style={{ background: "var(--gift-grad)", boxShadow: "0 4px 12px rgba(217,119,6,0.3)" }}>
            Publish offer
          </button>
        </div>

      </Form>

      {showToast && (
        <Toast message={toastMsg} type="error" onDismiss={() => setShowToast(false)} />
      )}

      {/* ── Modals ── */}
      <MainConditionModal
        open={mainCondModalOpen}
        initialSelected={selectedMainCond}
        onClose={() => setMainCondModalOpen(false)}
        onConfirm={(type) => setSelectedMainCond(type)}
      />

      <SubconditionModal
        open={subModalOpen}
        active={activeSubs}
        types={GIFT_SUBCONDITIONS}
        onClose={() => setSubModalOpen(false)}
        onConfirm={(ids) => {
          setActiveSubs(ids);
          setSubValues((prev) => {
            const next: Record<string, unknown> = {};
            for (const id of ids) next[id] = prev[id] ?? {};
            return next;
          });
        }}
      />

      <ProductPicker
        open={condPickerOpen}
        onClose={() => setCondPickerOpen(false)}
        title="Select condition products"
        allowMultiple
        selectedIds={conditionProducts}
        onSelect={(gids) => setConditionProducts(gids)}
      />

      <ProductPicker
        open={rewardPickerOpen}
        onClose={() => setRewardPickerOpen(false)}
        title="Select gifts"
        allowMultiple
        selectedIds={rewardProducts}
        onSelect={(gids) => setRewardProducts(gids)}
      />

    </div>
  );
}
