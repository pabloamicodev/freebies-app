/**
 * Discount Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/discount/volume   → Volume discount wizard
 *         /app/offers/new/discount/cheapest → Cheapest/Most expensive item discount
 *         /app/offers/new/discount/cart     → Cart discount wizard
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// ─── Slug → internal template ID ─────────────────────────────────────────────

const SLUG_TO_TEMPLATE: Record<string, string> = {
  "volume": "volume",
  "cheapest": "cheapest_item",
  "cart": "cart",
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
  const publicTitle = (formData.get("publicTitle") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;
  const startsAt = formData.get("startsAt") as string;
  const endsAt = formData.get("endsAt") as string;
  const discountTemplate = formData.get("discountTemplate") as string;

  if (!internalName || !publicTitle) {
    return { error: "Internal name and public title are required" };
  }

  const applyTo = (formData.get("applyTo") as string) || "any_product";
  const countRule = (formData.get("countRule") as string) || "all";
  const displayType = (formData.get("displayType") as string) || "quantity_options";
  const discountOnItem = (formData.get("discountOnItem") as string) || "cheapest";
  const cartDiscountBy = (formData.get("cartDiscountBy") as string) || "cart_value";
  const cartDiscountType = (formData.get("cartDiscountType") as string) || "percentage";
  const maxUsesEnabled = formData.get("maxUsesEnabled") === "on";
  const maxUsePerCustomerEnabled = formData.get("maxUsePerCustomerEnabled") === "on";

  const combinesOrderDiscounts = formData.get("combinesOrderDiscounts") === "on";
  const combinesShippingDiscounts = formData.get("combinesShippingDiscounts") === "on";
  const combinesProductDiscounts = formData.get("combinesProductDiscounts") === "on";

  const upsellProductsJson = (formData.get("upsellProducts") as string) || "[]";
  let upsellProducts: string[] = [];
  try { upsellProducts = JSON.parse(upsellProductsJson) as string[]; } catch {}

  // ── Parse tiers (volume) ──
  const tierQtys = formData.getAll("tier_qty[]") as string[];
  const tierLabels = formData.getAll("tier_label[]") as string[];
  const tierDiscountTypes = formData.getAll("tier_discount_type[]") as string[];
  const tierDiscountValues = formData.getAll("tier_discount_value[]") as string[];
  const tierTags1 = formData.getAll("tier_tag_1[]") as string[];
  const tierTags2 = formData.getAll("tier_tag_2[]") as string[];
  const tierPreselected = formData.getAll("tier_preselected[]") as string[];

  const volumeTiers = tierQtys.map((qty, i) => ({
    qty: parseInt(qty, 10) || 1,
    label: tierLabels[i] ?? "",
    discountType: tierDiscountTypes[i] ?? "percentage",
    discountValue: parseFloat(tierDiscountValues[i] ?? "0"),
    tag1: tierTags1[i] ?? "",
    tag2: tierTags2[i] ?? "",
    preselected: tierPreselected[i] === "true",
  }));

  // ── Parse cheapest tiers ──
  const cheapestRequiredQtys = formData.getAll("cheapest_required_qty[]") as string[];
  const cheapestDiscountedQtys = formData.getAll("cheapest_discounted_qty[]") as string[];
  const cheapestDiscountTypes = formData.getAll("cheapest_discount_type[]") as string[];
  const cheapestDiscountValues = formData.getAll("cheapest_discount_value[]") as string[];
  const cheapestLabels = formData.getAll("cheapest_label[]") as string[];

  const cheapestTiers = cheapestRequiredQtys.map((rq, i) => ({
    requiredQty: parseInt(rq, 10) || 1,
    discountedQty: parseInt(cheapestDiscountedQtys[i] ?? "1", 10) || 1,
    discountType: cheapestDiscountTypes[i] ?? "percentage",
    discountValue: parseFloat(cheapestDiscountValues[i] ?? "100"),
    label: cheapestLabels[i] ?? "",
  }));

  // ── Parse cart tiers ──
  const cartTierThresholds = formData.getAll("cart_tier_threshold[]") as string[];
  const cartTierDiscountTypes = formData.getAll("cart_tier_discount_type[]") as string[];
  const cartTierDiscountValues = formData.getAll("cart_tier_discount_value[]") as string[];
  const cartTierLabels = formData.getAll("cart_tier_label[]") as string[];

  const cartTiers = cartTierThresholds.map((th, i) => ({
    threshold: parseFloat(th) || 0,
    discountType: cartTierDiscountTypes[i] ?? "percentage",
    discountValue: parseFloat(cartTierDiscountValues[i] ?? "0"),
    label: cartTierLabels[i] ?? "",
  }));

  const status = intent === "publish" ? "active" : "draft";

  async function createOffer(candidateName: string) {
    const [offer] = await db
      .insert(offers)
      .values({
        shopId,
        type: "discount",
        status,
        internalName: candidateName,
        publicTitle,
        description: description ?? undefined,
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

  // ── Condition ──
  const conditionValue: Record<string, unknown> = {
    discountTemplate,
    applyTo,
    countRule,
    displayType,
    discountOnItem,
    cartDiscountBy,
    cartDiscountType,
    maxUsesEnabled,
    maxUsePerCustomerEnabled,
    upsellProducts,
  };

  const tiersPayload =
    discountTemplate === "volume"
      ? volumeTiers
      : discountTemplate === "cheapest_item"
      ? cheapestTiers
      : cartTiers;

  await Promise.all([
    db.insert(offerConditions).values({
      shopId,
      offerId: newOffer.id,
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: conditionValue,
      sortOrder: 0,
      isEnabled: true,
    }),
    db.insert(offerRewards).values({
      shopId,
      offerId: newOffer.id,
      rewardType: "order_discount",
      discountType: "percentage",
      value: {
        discountTemplate,
        tiers: tiersPayload,
      },
      target: { scope: "cart" },
      sortOrder: 0,
      trackMode: "product",
      isAutoAdd: false,
      isCustomerSelectable: false,
    }),
    db.insert(offerCombinationPolicies).values({
      shopId,
      offerId: newOffer.id,
      combinesWithOrderDiscounts: combinesOrderDiscounts,
      combinesWithProductDiscounts: combinesProductDiscounts,
      combinesWithShippingDiscounts: combinesShippingDiscounts,
      combinesWithOtherAppOffers: true,
      stopLowerPriority: false,
      giftValueCountsForOtherOffers: false,
    }),
  ]);

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Pre-filled defaults per template ────────────────────────────────────────

const TEMPLATE_DEFAULTS: Record<string, { internalName: string; publicTitle: string }> = {
  volume: {
    internalName: "Volume discount 1",
    publicTitle: "Volume discount save",
  },
  cheapest_item: {
    internalName: "Discount on cheapest 1",
    publicTitle: "Buy more, Free for the cheapest!",
  },
  cart: {
    internalName: "Cart discount #1",
    publicTitle: "Buy more get more",
  },
};

// ─── Tier types ──────────────────────────────────────────────────────────────

interface VolumeTier {
  id: string;
  qty: string;
  label: string;
  discountType: string;
  value: string;
  tag1: string;
  tag2: string;
  preselected: boolean;
}

interface CheapestTier {
  id: string;
  requiredQty: string;
  discountedQty: string;
  discountType: string;
  discountValue: string;
  label: string;
}

interface CartTier {
  id: string;
  threshold: string;
  discountType: string;
  discountValue: string;
  label: string;
}

function createClientId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random()}`;
}

function createVolumeTier(values: Omit<VolumeTier, "id">): VolumeTier {
  return { id: createClientId("volume-tier"), ...values };
}

function createCheapestTier(values: Omit<CheapestTier, "id">): CheapestTier {
  return { id: createClientId("cheapest-tier"), ...values };
}

function createCartTier(values: Omit<CartTier, "id">): CartTier {
  return { id: createClientId("cart-tier"), ...values };
}

// ─── Currency chips (visual only) ────────────────────────────────────────────

const CURRENCY_CHIPS = [
  "AFN","AUD","AWG","BBD","BZD","CAD","CNY","DJF","EUR","FKP",
  "GBP","GHS","HKD","IDR","INR","JPY","KES","MXN","NGN","NZD",
  "PKR","PLN","SEK","SGD","THB","TRY","USD","ZAR",
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewDiscountOfferPage() {
  const navigate = useNavigate();
  const { template: templateSlug = "volume" } = useParams<{ template: string }>();

  const templateId = SLUG_TO_TEMPLATE[templateSlug] ?? "volume";
  const defaults = TEMPLATE_DEFAULTS[templateId] ?? { internalName: "Volume discount 1", publicTitle: "Volume discount save" };

  const [formState, setFormField] = useObjectState(() => ({
    fieldErrors: {} as { internalName?: string; publicTitle?: string },
    showToast: false,
    toastMsg: "",
    internalName: defaults.internalName,
    publicTitle: defaults.publicTitle,
    description: "",
    startsAt: new Date().toISOString().slice(0, 16),
    endsAt: "",
    applyTo: templateId === "volume" ? "selected_products" : "any_product",
    productPickerOpen: false,
    selectedProducts: [] as string[],
    displayType: "quantity_options",
    countRule: "all",
    tiers: [
      createVolumeTier({ qty: "2", label: "Double", discountType: "percentage", value: "20", tag1: "20% OFF", tag2: "Most popular", preselected: false }),
      createVolumeTier({ qty: "3", label: "Triple", discountType: "percentage", value: "30", tag1: "30% OFF", tag2: "Most value", preselected: true }),
    ] as VolumeTier[],
    discountOnItem: "cheapest",
    cheapestTiers: [
      createCheapestTier({ requiredQty: "3", discountedQty: "1", discountType: "percentage", discountValue: "100", label: "Buy 3, get 1 cheapest for free" }),
    ] as CheapestTier[],
    cartDiscountBy: "cart_value",
    cartDiscountType: "percentage",
    maxUsesEnabled: false,
    maxUsePerCustomerEnabled: false,
    cartTiers: [
      createCartTier({ threshold: "100", discountType: "percentage", discountValue: "5", label: "Buy $100 get 5% OFF" }),
    ] as CartTier[],
    combinesOrderDiscounts: true,
    combinesShippingDiscounts: true,
    combinesProductDiscounts: true,
  }));
  const {
    fieldErrors,
    showToast,
    toastMsg,
    internalName,
    publicTitle,
    description,
    startsAt,
    endsAt,
    applyTo,
    productPickerOpen,
    selectedProducts,
    displayType,
    countRule,
    tiers,
    discountOnItem,
    cheapestTiers,
    cartDiscountBy,
    cartDiscountType,
    maxUsesEnabled,
    maxUsePerCustomerEnabled,
    cartTiers,
    combinesOrderDiscounts,
    combinesShippingDiscounts,
    combinesProductDiscounts,
  } = formState;
  const setFieldErrors = createFieldSetter(setFormField, "fieldErrors");
  const setShowToast = createFieldSetter(setFormField, "showToast");
  const setToastMsg = createFieldSetter(setFormField, "toastMsg");
  const setInternalName = createFieldSetter(setFormField, "internalName");
  const setPublicTitle = createFieldSetter(setFormField, "publicTitle");
  const setDescription = createFieldSetter(setFormField, "description");
  const setStartsAt = createFieldSetter(setFormField, "startsAt");
  const setEndsAt = createFieldSetter(setFormField, "endsAt");
  const setApplyTo = createFieldSetter(setFormField, "applyTo");
  const setProductPickerOpen = createFieldSetter(setFormField, "productPickerOpen");
  const setSelectedProducts = createFieldSetter(setFormField, "selectedProducts");
  const setDisplayType = createFieldSetter(setFormField, "displayType");
  const setCountRule = createFieldSetter(setFormField, "countRule");
  const setTiers = createFieldSetter(setFormField, "tiers");
  const setDiscountOnItem = createFieldSetter(setFormField, "discountOnItem");
  const setCheapestTiers = createFieldSetter(setFormField, "cheapestTiers");
  const setCartDiscountBy = createFieldSetter(setFormField, "cartDiscountBy");
  const setCartDiscountType = createFieldSetter(setFormField, "cartDiscountType");
  const setMaxUsesEnabled = createFieldSetter(setFormField, "maxUsesEnabled");
  const setMaxUsePerCustomerEnabled = createFieldSetter(setFormField, "maxUsePerCustomerEnabled");
  const setCartTiers = createFieldSetter(setFormField, "cartTiers");
  const setCombinesOrderDiscounts = createFieldSetter(setFormField, "combinesOrderDiscounts");
  const setCombinesShippingDiscounts = createFieldSetter(setFormField, "combinesShippingDiscounts");
  const setCombinesProductDiscounts = createFieldSetter(setFormField, "combinesProductDiscounts");

  function validate() {
    const errs: { internalName?: string; publicTitle?: string } = {};
    if (!internalName.trim()) errs.internalName = "Offer name is required";
    if (!publicTitle.trim()) errs.publicTitle = "Offer title is required";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

  // ── Tier helpers ──

  function addVolumeTier() {
    setTiers((prev) => [
      ...prev,
      createVolumeTier({ qty: "", label: "", discountType: "percentage", value: "", tag1: "", tag2: "", preselected: false }),
    ]);
  }
  function removeVolumeTier(i: number) {
    setTiers((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateVolumeTier(i: number, field: keyof VolumeTier, val: string | boolean) {
    setTiers((prev) => prev.map((t, idx) => idx === i ? ({ ...t, [field]: val } as VolumeTier) : t));
  }

  function addCheapestTier() {
    setCheapestTiers((prev) => [
      ...prev,
      createCheapestTier({ requiredQty: "", discountedQty: "1", discountType: "percentage", discountValue: "100", label: "" }),
    ]);
  }
  function removeCheapestTier(i: number) {
    setCheapestTiers((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateCheapestTier(i: number, field: keyof CheapestTier, val: string) {
    setCheapestTiers((prev) => prev.map((t, idx) => idx === i ? ({ ...t, [field]: val } as CheapestTier) : t));
  }

  function addCartTier() {
    setCartTiers((prev) => [
      ...prev,
      createCartTier({ threshold: "", discountType: "percentage", discountValue: "", label: "" }),
    ]);
  }
  function removeCartTier(i: number) {
    setCartTiers((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateCartTier(i: number, field: keyof CartTier, val: string) {
    setCartTiers((prev) => prev.map((t, idx) => idx === i ? ({ ...t, [field]: val } as CartTier) : t));
  }

  // ── Page title ──
  const pageTitle =
    templateId === "volume"
      ? "Create volume discount"
      : templateId === "cheapest_item"
      ? "Create cheapest/most expensive item discount"
      : "Create cart discount";

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
          <div className="rd-style-076">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>{pageTitle}</h1>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Configure your discount offer</div>
          </div>
          <span className="rd-style-077">Discount</span>
        </div>
      </div>

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        {/* Hidden fields */}
        <input type="hidden" name="discountTemplate" value={templateId} />
        <input type="hidden" name="upsellProducts" value={JSON.stringify(selectedProducts)} />

        {/* Tier arrays — volume */}
        {templateId === "volume" && tiers.map((tier, i) => (
          <span key={tier.id}>
            <input type="hidden" name="tier_qty[]" value={tier.qty} />
            <input type="hidden" name="tier_label[]" value={tier.label} />
            <input type="hidden" name="tier_discount_type[]" value={tier.discountType} />
            <input type="hidden" name="tier_discount_value[]" value={tier.value} />
            <input type="hidden" name="tier_tag_1[]" value={tier.tag1} />
            <input type="hidden" name="tier_tag_2[]" value={tier.tag2} />
            <input type="hidden" name="tier_preselected[]" value={String(tier.preselected)} />
          </span>
        ))}

        {/* Tier arrays — cheapest */}
        {templateId === "cheapest_item" && cheapestTiers.map((tier, i) => (
          <span key={tier.id}>
            <input type="hidden" name="cheapest_required_qty[]" value={tier.requiredQty} />
            <input type="hidden" name="cheapest_discounted_qty[]" value={tier.discountedQty} />
            <input type="hidden" name="cheapest_discount_type[]" value={tier.discountType} />
            <input type="hidden" name="cheapest_discount_value[]" value={tier.discountValue} />
            <input type="hidden" name="cheapest_label[]" value={tier.label} />
          </span>
        ))}

        {/* Tier arrays — cart */}
        {templateId === "cart" && cartTiers.map((tier, i) => (
          <span key={tier.id}>
            <input type="hidden" name="cart_tier_threshold[]" value={tier.threshold} />
            <input type="hidden" name="cart_tier_discount_type[]" value={tier.discountType} />
            <input type="hidden" name="cart_tier_discount_value[]" value={tier.discountValue} />
            <input type="hidden" name="cart_tier_label[]" value={tier.label} />
          </span>
        ))}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20, alignItems: "start" }}>

          {/* ── Left column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ────────────────────────────────────────────────
                VOLUME — Basic information
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card" style={{ borderTop: "3px solid var(--discount-color)" }}>
                <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                  <div className="rd-style-078">1</div>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Basic information</span>
                  <span className="rd-style-079">1</span>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Discount name</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                    <div className="b-help">Internal use only, not shown to customers.</div>
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Discount title</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Discount description</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(optional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Start time</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">End time</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Offer information
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Offer information</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Offer name</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Discount title</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Block description</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(optional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Start time</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">End time</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CART — Offer information
            ──────────────────────────────────────────────── */}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Offer information</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Offer name</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Offer title</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Block description</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(optional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Start time</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">End time</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                VOLUME — Card "Offers"
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Offers</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* Regla de cantidad */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label className="b-label" htmlFor="discount-count-rule">Count rule</label>
                      <select id="discount-count-rule" aria-label="Count rule" className="b-select" name="countRule"
                        value={countRule} onChange={(e) => setCountRule(e.target.value)}>
                        <option value="all">Count all products</option>
                        <option value="unique">Count identical products only</option>
                      </select>
                    </div>
                    <button type="button" className="b-btn b-btn-secondary" style={{ marginTop: 20, whiteSpace: "nowrap" }}>
                      Selection logic
                    </button>
                  </div>

                  {/* Display type */}
                  <div>
                    <div className="b-label">Choose display type:</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      <label className="b-checkbox-row" htmlFor="discount-display-quantity-options" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-display-quantity-options" aria-label="Quantity options" type="radio" name="displayType" value="quantity_options"
                          checked={displayType === "quantity_options"}
                          onChange={() => setDisplayType("quantity_options")}
                          style={{ accentColor: "var(--discount-color)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Quantity options</span>
                      </label>
                      <label className="b-checkbox-row" htmlFor="discount-display-table" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-display-table" aria-label="Quantity discount table" type="radio" name="displayType" value="discount_table"
                          checked={displayType === "discount_table"}
                          onChange={() => setDisplayType("discount_table")}
                          style={{ accentColor: "var(--discount-color)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Quantity discount table</span>
                      </label>
                    </div>
                  </div>

                  {/* Referirse a */}
                  <div>
                    <label className="b-label" htmlFor="discount-volume-apply-to">Apply to:</label>
                    <select id="discount-volume-apply-to" aria-label="Apply to" className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="selected_products">selected products</option>
                      <option value="any_product">any product</option>
                    </select>
                  </div>

                  {applyTo === "selected_products" && (
                    <div>
                      <div className="b-label">Products:</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary"
                          onClick={() => setProductPickerOpen(true)}>
                          Select products
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {selectedProducts.length} products selected
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Card "Offers"
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Offers</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="discount-cheapest-apply-to">Apply to:</label>
                    <select id="discount-cheapest-apply-to" aria-label="Apply to" className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="any_product">any product</option>
                      <option value="selected_products">selected products</option>
                    </select>
                  </div>
                  {applyTo === "selected_products" && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary"
                          onClick={() => setProductPickerOpen(true)}>
                          Select products
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {selectedProducts.length} products selected
                        </span>
                      </div>
                    </div>
                  )}
                  <label className="b-checkbox-row" htmlFor="discount-count-unique" style={{ cursor: "pointer", gap: 8 }}>
                    <input id="discount-count-unique" aria-label="Count unique products only" type="checkbox" name="countRule" value="unique"
                      checked={countRule === "unique"}
                      onChange={(e) => setCountRule(e.target.checked ? "unique" : "all")} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>Count unique products only</span>
                  </label>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CART — Card "Offers"
            ──────────────────────────────────────────────── */}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Offers</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="discount-cart-apply-to">Apply to cart with:</label>
                    <select id="discount-cart-apply-to" aria-label="Apply to cart with" className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="any_product">any product</option>
                      <option value="selected_products">selected products</option>
                    </select>
                  </div>
                  {applyTo === "selected_products" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setProductPickerOpen(true)}>
                        Seleccionar productos
                      </button>
                      <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                        {selectedProducts.length} products selected
                      </span>
                    </div>
                  )}
                  <div>
                    <div className="b-label" style={{ marginBottom: 8 }}>Maximum discount usage</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label className="b-checkbox-row" htmlFor="discount-max-uses-enabled" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-max-uses-enabled" aria-label="Limit the number of times this discount can be used in total" type="checkbox" name="maxUsesEnabled"
                          checked={maxUsesEnabled}
                          onChange={(e) => setMaxUsesEnabled(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>
                          Limit the number of times this discount can be used in total
                        </span>
                      </label>
                      <label className="b-checkbox-row" htmlFor="discount-max-use-per-customer" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-max-use-per-customer" aria-label="Limit to one use per customer" type="checkbox" name="maxUsePerCustomerEnabled"
                          checked={maxUsePerCustomerEnabled}
                          onChange={(e) => setMaxUsePerCustomerEnabled(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>
                          Limit to one use per customer
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Agregar subcondición (all templates) ── */}
            <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
              <div className="b-card-body rd-style-080">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Add sub-condition
              </div>
            </div>

            {/* ────────────────────────────────────────────────
                VOLUME — Card "Niveles"
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Tiers</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {tiers.map((tier, i) => (
                    <div key={tier.id} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Tier {i + 1}</span>
                        <button type="button" aria-label={`Remove tier ${i + 1}`} onClick={() => removeVolumeTier(i)}
                          className="b-modal-close" style={{ width: 22, height: 22 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label" htmlFor={`volume-tier-${tier.id}-qty`}>Quantity</label>
                            <input id={`volume-tier-${tier.id}-qty`} aria-label={`Tier ${i + 1} quantity`} className="b-input" type="number" min="1"
                              value={tier.qty} onChange={(e) => updateVolumeTier(i, "qty", e.target.value)}
                              autoComplete="off" />
                          </div>
                          <div>
                            <label className="b-label" htmlFor={`volume-tier-${tier.id}-label`}>Title</label>
                            <input id={`volume-tier-${tier.id}-label`} aria-label={`Tier ${i + 1} title`} className="b-input"
                              value={tier.label} onChange={(e) => updateVolumeTier(i, "label", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label" htmlFor={`volume-tier-${tier.id}-discount-type`}>Discount type</label>
                            <select id={`volume-tier-${tier.id}-discount-type`} aria-label={`Tier ${i + 1} discount type`} className="b-select"
                              value={tier.discountType} onChange={(e) => updateVolumeTier(i, "discountType", e.target.value)}>
                              <option value="percentage">Percentage</option>
                              <option value="fixed_amount">Fixed amount</option>
                              <option value="fixed_price">Fixed price</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label" htmlFor={`volume-tier-${tier.id}-value`}>Value</label>
                            <input id={`volume-tier-${tier.id}-value`} aria-label={`Tier ${i + 1} value`} className="b-input" type="number" min="0"
                              value={tier.value} onChange={(e) => updateVolumeTier(i, "value", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--discount-color)", cursor: "pointer" }}>
                          Add: Shipping discount
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <div className="b-checkbox-row" style={{ gap: 8, alignItems: "center" }}>
                            <input aria-label={`Enable tier ${i + 1} label 1`} type="checkbox" defaultChecked style={{ accentColor: "var(--discount-color)" }} />
                            <input aria-label={`Tier ${i + 1} label 1`} className="b-input" style={{ flex: 1 }}
                              value={tier.tag1} onChange={(e) => updateVolumeTier(i, "tag1", e.target.value)}
                              placeholder="Label 1" autoComplete="off" />
                          </div>
                          <div className="b-checkbox-row" style={{ gap: 8, alignItems: "center" }}>
                            <input aria-label={`Enable tier ${i + 1} label 2`} type="checkbox" defaultChecked style={{ accentColor: "var(--discount-color)" }} />
                            <input aria-label={`Tier ${i + 1} label 2`} className="b-input" style={{ flex: 1 }}
                              value={tier.tag2} onChange={(e) => updateVolumeTier(i, "tag2", e.target.value)}
                              placeholder="Label 2" autoComplete="off" />
                          </div>
                          <label className="b-checkbox-row" htmlFor={`volume-tier-${tier.id}-preselected`} style={{ gap: 8, cursor: "pointer" }}>
                            <input id={`volume-tier-${tier.id}-preselected`} aria-label={`Tier ${i + 1} preselected`} type="checkbox"
                              checked={tier.preselected}
                              onChange={(e) => updateVolumeTier(i, "preselected", e.target.checked)}
                              style={{ accentColor: "var(--discount-color)" }} />
                            <span style={{ fontSize: 13, color: "var(--text)" }}>Preselected</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  ))}

                  <div style={{ fontSize: 12, color: "var(--text-sub)", background: "var(--bg-hover)", borderRadius: 6, padding: "8px 12px", border: "1px solid var(--border)" }}>
                    Items exceeding the previous tier quantity will not receive a discount.
                  </div>

                  <button type="button" className="b-btn b-btn-secondary"
                    onClick={addVolumeTier} style={{ alignSelf: "flex-start" }}>
                    + Add tier
                  </button>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Card "Niveles"
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Tiers</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* Descuento sobre */}
                  <div>
                    <div className="b-label">Discount on:</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      <label className="b-checkbox-row" htmlFor="discount-on-cheapest" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-on-cheapest" aria-label="Cheapest item" type="radio" name="discountOnItem" value="cheapest"
                          checked={discountOnItem === "cheapest"}
                          onChange={() => setDiscountOnItem("cheapest")}
                          style={{ accentColor: "var(--discount-color)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Cheapest item</span>
                      </label>
                      <label className="b-checkbox-row" htmlFor="discount-on-most-expensive" style={{ cursor: "pointer", gap: 8 }}>
                        <input id="discount-on-most-expensive" aria-label="Most expensive item" type="radio" name="discountOnItem" value="most_expensive"
                          checked={discountOnItem === "most_expensive"}
                          onChange={() => setDiscountOnItem("most_expensive")}
                          style={{ accentColor: "var(--discount-color)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Most expensive item</span>
                      </label>
                    </div>
                  </div>

                  {cheapestTiers.map((tier, i) => (
                    <div key={tier.id} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Tier {i + 1}</span>
                        <button type="button" aria-label={`Remove tier ${i + 1}`} onClick={() => removeCheapestTier(i)}
                          className="b-modal-close" style={{ width: 22, height: 22 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label" htmlFor={`cheapest-tier-${tier.id}-required`}>Required items count</label>
                            <input id={`cheapest-tier-${tier.id}-required`} aria-label={`Tier ${i + 1} required items count`} className="b-input" type="number" min="1"
                              value={tier.requiredQty} onChange={(e) => updateCheapestTier(i, "requiredQty", e.target.value)}
                              autoComplete="off" />
                          </div>
                          <div>
                            <label className="b-label" htmlFor={`cheapest-tier-${tier.id}-discounted`}>Discounted items count</label>
                            <input id={`cheapest-tier-${tier.id}-discounted`} aria-label={`Tier ${i + 1} discounted items count`} className="b-input" type="number" min="1"
                              value={tier.discountedQty} onChange={(e) => updateCheapestTier(i, "discountedQty", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label" htmlFor={`cheapest-tier-${tier.id}-type`}>Type</label>
                            <select id={`cheapest-tier-${tier.id}-type`} aria-label={`Tier ${i + 1} discount type`} className="b-select"
                              value={tier.discountType} onChange={(e) => updateCheapestTier(i, "discountType", e.target.value)}>
                              <option value="percentage">Percentage</option>
                              <option value="fixed_amount">Fixed amount</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label" htmlFor={`cheapest-tier-${tier.id}-value`}>Value</label>
                            <input id={`cheapest-tier-${tier.id}-value`} aria-label={`Tier ${i + 1} discount value`} className="b-input" type="number" min="0"
                              value={tier.discountValue} onChange={(e) => updateCheapestTier(i, "discountValue", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div>
                          <label className="b-label" htmlFor={`cheapest-tier-${tier.id}-label`}>Label text</label>
                          <input id={`cheapest-tier-${tier.id}-label`} aria-label={`Tier ${i + 1} label text`} className="b-input"
                            value={tier.label} onChange={(e) => updateCheapestTier(i, "label", e.target.value)}
                            autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  ))}

                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <button type="button" className="b-btn b-btn-secondary"
                      onClick={addCheapestTier}>
                      + Add tier
                    </button>
                    <label className="b-checkbox-row" htmlFor="discount-multiply-last-tier" style={{ cursor: "pointer", gap: 8 }}>
                      <input id="discount-multiply-last-tier" aria-label="Multiply the last tier" type="checkbox" style={{ accentColor: "var(--discount-color)" }} />
                      <span style={{ fontSize: 13, color: "var(--text)" }}>Multiply the last tier</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CART — Card "Descuento"
            ──────────────────────────────────────────────── */}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Descuento</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="discount-cart-discount-by">Discount by:</label>
                      <select id="discount-cart-discount-by" aria-label="Discount by" className="b-select" name="cartDiscountBy"
                        value={cartDiscountBy} onChange={(e) => setCartDiscountBy(e.target.value)}>
                        <option value="cart_value">Cart value</option>
                        <option value="quantity">Quantity</option>
                      </select>
                    </div>
                    <div>
                      <label className="b-label" htmlFor="discount-cart-discount-type">Discount type:</label>
                      <select id="discount-cart-discount-type" aria-label="Discount type" className="b-select" name="cartDiscountType"
                        value={cartDiscountType} onChange={(e) => setCartDiscountType(e.target.value)}>
                        <option value="percentage">Percentage</option>
                        <option value="fixed_amount">Fixed amount</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 4 }}>Tiers</div>

                  {cartTiers.map((tier, i) => (
                    <div key={tier.id} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Tier {i + 1}</span>
                        <button type="button" aria-label={`Remove tier ${i + 1}`} onClick={() => removeCartTier(i)}
                          className="b-modal-close" style={{ width: 22, height: 22 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label" htmlFor={`cart-tier-${tier.id}-threshold`}>Required cart value</label>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 13, color: "var(--text-sub)", fontWeight: 500 }}>$</span>
                              <input id={`cart-tier-${tier.id}-threshold`} aria-label={`Tier ${i + 1} required cart value`} className="b-input" type="number" min="0" step="0.01"
                                value={tier.threshold} onChange={(e) => updateCartTier(i, "threshold", e.target.value)}
                                autoComplete="off" />
                            </div>
                          </div>
                          <div>
                            <label className="b-label" htmlFor={`cart-tier-${tier.id}-discount-value`}>Discount value</label>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 13, color: "var(--text-sub)", fontWeight: 500 }}>%</span>
                              <input id={`cart-tier-${tier.id}-discount-value`} aria-label={`Tier ${i + 1} discount value`} className="b-input" type="number" min="0"
                                value={tier.discountValue} onChange={(e) => updateCartTier(i, "discountValue", e.target.value)}
                                autoComplete="off" />
                            </div>
                          </div>
                        </div>

                        {/* Currency chips (visual only) */}
                        <div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 6 }}>Add currency</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {CURRENCY_CHIPS.map((code) => (
                              <span key={code} className="rd-style-081">
                                {code}
                              </span>
                            ))}
                          </div>
                        </div>

                        <label className="b-checkbox-row" htmlFor={`cart-tier-${tier.id}-maximum`} style={{ cursor: "pointer", gap: 8 }}>
                          <input id={`cart-tier-${tier.id}-maximum`} aria-label={`Tier ${i + 1} maximum discount value`} type="checkbox" style={{ accentColor: "var(--discount-color)" }} />
                          <span style={{ fontSize: 13, color: "var(--text)" }}>Maximum discount value</span>
                        </label>

                        <div>
                          <label className="b-label" htmlFor={`cart-tier-${tier.id}-label`}>Tier label text</label>
                          <input id={`cart-tier-${tier.id}-label`} aria-label={`Tier ${i + 1} label text`} className="b-input"
                            value={tier.label} onChange={(e) => updateCartTier(i, "label", e.target.value)}
                            autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  ))}

                  <button type="button" className="b-btn b-btn-secondary"
                    onClick={addCartTier} style={{ alignSelf: "flex-start" }}>
                    + Add tier
                  </button>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                VOLUME — Suscripción card
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Subscription</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                    <input type="checkbox" style={{ accentColor: "var(--discount-color)" }} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>
                      Show subscription options in widget
                    </span>
                  </label>
                  <div style={{ fontSize: 12, color: "var(--discount-color)", background: "var(--bg-hover)", borderRadius: 6, padding: "8px 12px", border: "1px solid var(--border)" }}>
                    Tip: Integrate with Appstle to show subscription options alongside the volume discount.
                  </div>
                </div>
              </div>
            )}

            {/* ── Código de descuento (all templates) ── */}
            <div className="b-card">
              <div className="b-card-header">Discount code</div>
              <div className="b-card-body">
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" style={{ accentColor: "var(--discount-color)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>
                    Add a custom discount code
                  </span>
                </label>
              </div>
            </div>

            {/* ── Este descuento se puede combinar con ── */}
            <div className="b-card">
              <div className="b-card-header">This discount can be combined with</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {templateId === "cart" && (
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                    <input type="checkbox" name="combinesProductDiscounts"
                      checked={combinesProductDiscounts}
                      onChange={(e) => setCombinesProductDiscounts(e.target.checked)}
                      style={{ accentColor: "var(--discount-color)" }} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>Product discounts</span>
                  </label>
                )}
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name="combinesOrderDiscounts"
                    checked={combinesOrderDiscounts}
                    onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                    style={{ accentColor: "var(--discount-color)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>Order discounts</span>
                </label>
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name="combinesShippingDiscounts"
                    checked={combinesShippingDiscounts}
                    onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                    style={{ accentColor: "var(--discount-color)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>Shipping discounts</span>
                </label>
              </div>
            </div>

          </div>

          {/* ── Right column: Preview / Avance ── */}
          <div style={{ position: "sticky", top: 16 }}>
            {(templateId === "volume" || templateId === "cheapest_item") && (
              <div className="b-card">
                <div className="b-card-header">Preview</div>
                <div className="b-card-body">
                  {templateId === "volume" && (
                    <VolumePreview
                      title={publicTitle}
                      displayType={displayType}
                      tiers={tiers}
                    />
                  )}
                  {templateId === "cheapest_item" && (
                    <CheapestPreview
                      title={publicTitle}
                      tiers={cheapestTiers}
                    />
                  )}
                </div>
              </div>
            )}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Show discount in cart</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <CartPreviewSection title="Customize banner widget" />
                  <CartPreviewSection title="Add a greeting message" />
                  <CartPreviewSection title="Add a progress bar in the cart drawer" />
                </div>
              </div>
            )}
          </div>

        </div>

        {/* ── Footer ── */}
        <div className="rd-style-031">
          <button type="button" className="b-btn b-btn-secondary"
            onClick={() => void navigate("/app/offers")}>
            Cancel
          </button>
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary">
            Save draft
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-primary" style={{ background: "var(--discount-grad)", boxShadow: "0 4px 12px rgba(225,29,72,0.3)" }}>
            Publish offer
          </button>
        </div>

      </Form>

      <ProductPicker
        open={productPickerOpen}
        onClose={() => setProductPickerOpen(false)}
        title="Select products"
        allowMultiple
        selectedIds={selectedProducts}
        onSelect={(gids) => setSelectedProducts(gids)}
      />

      {showToast && (
        <Toast message={toastMsg} type="error" onDismiss={() => setShowToast(false)} />
      )}
    </div>
  );
}

// ─── Volume preview widget ────────────────────────────────────────────────────

function VolumePreview({
  title,
  displayType,
  tiers,
}: {
  title: string;
  displayType: string;
  tiers: VolumeTier[];
}) {
  return (
    <div style={{ background: "var(--bg-hover)", borderRadius: 8, padding: 14, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
        {title || "Volume discount save"}
      </div>
      {displayType === "quantity_options" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {tiers.map((tier, i) => (
            <div key={tier.id} style={{
              border: tier.preselected ? "2px solid var(--discount-color)" : "1px solid var(--border)",
              borderRadius: 6, padding: "8px 10px", background: tier.preselected ? "rgba(225,29,72,0.04)" : "var(--bg)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  {tier.qty ? `${tier.qty}x` : `—`} {tier.label || `Tier ${i + 1}`}
                </div>
                {tier.tag2 && <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{tier.tag2}</div>}
              </div>
              {tier.tag1 && (
                <span style={{ fontSize: 12, background: "#008060", color: "white", borderRadius: 4, padding: "2px 6px" }}>
                  {tier.tag1}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--text-sub)" }}>Qty</th>
              <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--text-sub)" }}>Discount</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 6px", color: "var(--text)" }}>{tier.qty || "—"}</td>
                <td style={{ padding: "4px 6px", color: "var(--text)" }}>
                  {tier.value ? `${tier.value}${tier.discountType === "percentage" ? "%" : "$"}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Cheapest preview widget ──────────────────────────────────────────────────

function CheapestPreview({
  title,
  tiers,
}: {
  title: string;
  tiers: CheapestTier[];
}) {
  return (
    <div style={{ background: "var(--bg-hover)", borderRadius: 8, padding: 14, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
        {title || "Buy more, Free for the cheapest!"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tiers.map((tier) => (
          <div key={tier.id} style={{
            border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px",
            background: "var(--bg)", fontSize: 12, color: "var(--text)",
          }}>
            {tier.label || `Buy ${tier.requiredQty}, get ${tier.discountedQty} discounted`}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Cart right panel accordion section ──────────────────────────────────────

function CartPreviewSection({ title }: { title: string }) {
  const [sectionState, setSectionField] = useObjectState({ open: false });
  const { open } = sectionState;
  const setOpen = createFieldSetter(setSectionField, "open");
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rd-style-082"
      >
        {title}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div style={{ padding: "0 0 12px", fontSize: 12, color: "var(--text-sub)" }}>
          Configure this section to customize the cart appearance.
        </div>
      )}
    </div>
  );
}
