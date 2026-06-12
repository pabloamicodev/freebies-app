/**
 * Discount Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/discount/volume   → Volume discount wizard
 *         /app/offers/new/discount/cheapest → Cheapest/Most expensive item discount
 *         /app/offers/new/discount/cart     → Cart discount wizard
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
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
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();
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

  // ── Create offer with 23505 retry ──
  let newOffer: { id: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateName = attempt === 0 ? internalName : `${internalName} (${attempt + 1})`;
    try {
      [newOffer] = await db
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
      break;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue;
      throw err;
    }
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

  await db.insert(offerConditions).values({
    shopId,
    offerId: newOffer.id,
    scope: "main",
    conditionType: "cart_value",
    operator: "gte",
    value: conditionValue,
    sortOrder: 0,
    isEnabled: true,
  });

  // ── Reward ──
  const tiersPayload =
    discountTemplate === "volume"
      ? volumeTiers
      : discountTemplate === "cheapest_item"
      ? cheapestTiers
      : cartTiers;

  await db.insert(offerRewards).values({
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
  });

  // ── Combination policies ──
  await db.insert(offerCombinationPolicies).values({
    shopId,
    offerId: newOffer.id,
    combinesWithOrderDiscounts: combinesOrderDiscounts,
    combinesWithProductDiscounts: combinesProductDiscounts,
    combinesWithShippingDiscounts: combinesShippingDiscounts,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  });

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
  qty: string;
  label: string;
  discountType: string;
  value: string;
  tag1: string;
  tag2: string;
  preselected: boolean;
}

interface CheapestTier {
  requiredQty: string;
  discountedQty: string;
  discountType: string;
  discountValue: string;
  label: string;
}

interface CartTier {
  threshold: string;
  discountType: string;
  discountValue: string;
  label: string;
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

  // Validation
  const [fieldErrors, setFieldErrors] = useState<{ internalName?: string; publicTitle?: string }>({});
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  function validate() {
    const errs: { internalName?: string; publicTitle?: string } = {};
    if (!internalName.trim()) errs.internalName = "Nombre de la oferta es requerido";
    if (!publicTitle.trim()) errs.publicTitle = "Título de la oferta es requerido";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

  // Basic info
  const [internalName, setInternalName] = useState(defaults.internalName);
  const [publicTitle, setPublicTitle] = useState(defaults.publicTitle);
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt] = useState("");

  // Shared settings
  const [applyTo, setApplyTo] = useState<string>(
    templateId === "volume" ? "selected_products" : "any_product"
  );
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);

  // Volume-specific
  const [displayType, setDisplayType] = useState("quantity_options");
  const [countRule, setCountRule] = useState("all");
  const [tiers, setTiers] = useState<VolumeTier[]>([
    { qty: "2", label: "Double", discountType: "percentage", value: "20", tag1: "20% OFF", tag2: "Most popular", preselected: false },
    { qty: "3", label: "Triple", discountType: "percentage", value: "30", tag1: "30% OFF", tag2: "Most value", preselected: true },
  ]);

  // Cheapest-specific
  const [discountOnItem, setDiscountOnItem] = useState("cheapest");
  const [cheapestTiers, setCheapestTiers] = useState<CheapestTier[]>([
    { requiredQty: "3", discountedQty: "1", discountType: "percentage", discountValue: "100", label: "Buy 3, get 1 cheapest for free" },
  ]);

  // Cart-specific
  const [cartDiscountBy, setCartDiscountBy] = useState("cart_value");
  const [cartDiscountType, setCartDiscountType] = useState("percentage");
  const [maxUsesEnabled, setMaxUsesEnabled] = useState(false);
  const [maxUsePerCustomerEnabled, setMaxUsePerCustomerEnabled] = useState(false);
  const [cartTiers, setCartTiers] = useState<CartTier[]>([
    { threshold: "100", discountType: "percentage", discountValue: "5", label: "Buy $100 get 5% OFF" },
  ]);

  // Combination policies
  const [combinesOrderDiscounts, setCombinesOrderDiscounts] = useState(true);
  const [combinesShippingDiscounts, setCombinesShippingDiscounts] = useState(true);
  const [combinesProductDiscounts, setCombinesProductDiscounts] = useState(true);

  // ── Tier helpers ──

  function addVolumeTier() {
    setTiers((prev) => [
      ...prev,
      { qty: "", label: "", discountType: "percentage", value: "", tag1: "", tag2: "", preselected: false },
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
      { requiredQty: "", discountedQty: "1", discountType: "percentage", discountValue: "100", label: "" },
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
      { threshold: "", discountType: "percentage", discountValue: "", label: "" },
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
      ? "Crear descuento por volumen"
      : templateId === "cheapest_item"
      ? "Crear descuento en el artículo más barato/más caro"
      : "Crear descuento en el carrito";

  return (
    <div className="b-page">

      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <button
          type="button"
          className="b-btn-plain b-text-sm"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 12 }}
          onClick={() => void navigate("/app/offers")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          All Offers
        </button>
        <h1 className="b-page-title">{pageTitle}</h1>
      </div>

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        {/* Hidden fields */}
        <input type="hidden" name="discountTemplate" value={templateId} />
        <input type="hidden" name="upsellProducts" value={JSON.stringify(selectedProducts)} />

        {/* Tier arrays — volume */}
        {templateId === "volume" && tiers.map((tier, i) => (
          <span key={i}>
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
          <span key={i}>
            <input type="hidden" name="cheapest_required_qty[]" value={tier.requiredQty} />
            <input type="hidden" name="cheapest_discounted_qty[]" value={tier.discountedQty} />
            <input type="hidden" name="cheapest_discount_type[]" value={tier.discountType} />
            <input type="hidden" name="cheapest_discount_value[]" value={tier.discountValue} />
            <input type="hidden" name="cheapest_label[]" value={tier.label} />
          </span>
        ))}

        {/* Tier arrays — cart */}
        {templateId === "cart" && cartTiers.map((tier, i) => (
          <span key={i}>
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
                VOLUME — Información básica
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Información básica</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Nombre del descuento</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                    <div className="b-help">Sólo para uso interno, no para mostrar a los clientes.</div>
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Título de descuento</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Descripción del descuento</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(opcional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Hora de inicio</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">Hora de fin</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Ofrecer información
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Ofrecer información</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Nombre de la oferta</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Título de descuento</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Descripción del bloque</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(opcional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Hora de inicio</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">Hora de fin</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CART — Información de la oferta
            ──────────────────────────────────────────────── */}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Información de la oferta</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label" htmlFor="internalName">Nombre de la oferta</label>
                    <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                      value={internalName} onChange={(e) => setInternalName(e.target.value)}
                      autoComplete="off" />
                  </div>
                  <div className="b-card" style={{ background: "var(--bg-hover)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Título de la oferta</label>
                        <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Descripción del bloque</label>
                        <input id="description" className="b-input" name="description"
                          value={description} onChange={(e) => setDescription(e.target.value)}
                          autoComplete="off" placeholder="(opcional)" />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label className="b-label" htmlFor="startsAt">Hora de inicio</label>
                      <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                        value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="endsAt">Hora de fin</label>
                      <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                        value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                VOLUME — Card "Ofertas"
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Ofertas</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* Regla de cantidad */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label className="b-label">Regla de cantidad</label>
                      <select className="b-select" name="countRule"
                        value={countRule} onChange={(e) => setCountRule(e.target.value)}>
                        <option value="all">Contar todos los productos</option>
                        <option value="unique">Sólo contar productos iguales</option>
                      </select>
                    </div>
                    <button type="button" className="b-btn b-btn-secondary" style={{ marginTop: 20, whiteSpace: "nowrap" }}>
                      Lógica de selección
                    </button>
                  </div>

                  {/* Display type */}
                  <div>
                    <label className="b-label">Elija el tipo de visualización:</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="radio" name="displayType" value="quantity_options"
                          checked={displayType === "quantity_options"}
                          onChange={() => setDisplayType("quantity_options")}
                          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Opciones de cantidad</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="radio" name="displayType" value="discount_table"
                          checked={displayType === "discount_table"}
                          onChange={() => setDisplayType("discount_table")}
                          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Tabla de descuentos por cantidad</span>
                      </label>
                    </div>
                  </div>

                  {/* Referirse a */}
                  <div>
                    <label className="b-label">Referirse a:</label>
                    <select className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="selected_products">productos seleccionados</option>
                      <option value="any_product">cualquier producto</option>
                    </select>
                  </div>

                  {applyTo === "selected_products" && (
                    <div>
                      <div className="b-label">Productos:</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary"
                          onClick={() => setProductPickerOpen(true)}>
                          Seleccionar productos
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {selectedProducts.length} productos seleccionados
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Card "Ofertas"
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Ofertas</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label">Referirse a:</label>
                    <select className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="any_product">cualquier producto</option>
                      <option value="selected_products">productos seleccionados</option>
                    </select>
                  </div>
                  {applyTo === "selected_products" && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary"
                          onClick={() => setProductPickerOpen(true)}>
                          Seleccionar productos
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                          {selectedProducts.length} productos seleccionados
                        </span>
                      </div>
                    </div>
                  )}
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                    <input type="checkbox" name="countRule" value="unique"
                      checked={countRule === "unique"}
                      onChange={(e) => setCountRule(e.target.checked ? "unique" : "all")} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>Cuente solo productos únicos</span>
                  </label>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CART — Card "Ofertas"
            ──────────────────────────────────────────────── */}
            {templateId === "cart" && (
              <div className="b-card">
                <div className="b-card-header">Ofertas</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label className="b-label">Aplicar al carrito con:</label>
                    <select className="b-select" name="applyTo"
                      value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
                      <option value="any_product">cualquier producto</option>
                      <option value="selected_products">productos seleccionados</option>
                    </select>
                  </div>
                  {applyTo === "selected_products" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setProductPickerOpen(true)}>
                        Seleccionar productos
                      </button>
                      <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                        {selectedProducts.length} productos seleccionados
                      </span>
                    </div>
                  )}
                  <div>
                    <div className="b-label" style={{ marginBottom: 8 }}>Usos de descuento máximo</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="checkbox" name="maxUsesEnabled"
                          checked={maxUsesEnabled}
                          onChange={(e) => setMaxUsesEnabled(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>
                          Límite el número de veces que se puede utilizar este descuento en total
                        </span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="checkbox" name="maxUsePerCustomerEnabled"
                          checked={maxUsePerCustomerEnabled}
                          onChange={(e) => setMaxUsePerCustomerEnabled(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>
                          Límite de un uso por cliente
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Agregar subcondición (all templates) ── */}
            <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
              <div className="b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", color: "var(--blue)", cursor: "pointer", fontWeight: 500, fontSize: 14 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Agregar subcondición
              </div>
            </div>

            {/* ────────────────────────────────────────────────
                VOLUME — Card "Niveles"
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Niveles</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {tiers.map((tier, i) => (
                    <div key={i} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Nivel {i + 1}</span>
                        <button type="button" onClick={() => removeVolumeTier(i)}
                          style={{ width: 20, height: 20, borderRadius: "50%", background: "#ff4d4d", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 14, padding: 0 }}>
                          ×
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label">Cantidad</label>
                            <input className="b-input" type="number" min="1"
                              value={tier.qty} onChange={(e) => updateVolumeTier(i, "qty", e.target.value)}
                              autoComplete="off" />
                          </div>
                          <div>
                            <label className="b-label">Título</label>
                            <input className="b-input"
                              value={tier.label} onChange={(e) => updateVolumeTier(i, "label", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label">Tipo de descuento</label>
                            <select className="b-select"
                              value={tier.discountType} onChange={(e) => updateVolumeTier(i, "discountType", e.target.value)}>
                              <option value="percentage">Porcentaje</option>
                              <option value="fixed_amount">Monto fijo</option>
                              <option value="fixed_price">Precio fijo</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label">Valor</label>
                            <input className="b-input" type="number" min="0"
                              value={tier.value} onChange={(e) => updateVolumeTier(i, "value", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--blue)", cursor: "pointer" }}>
                          Agregar: Descuento de envío
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <label className="b-checkbox-row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
                            <input type="checkbox" defaultChecked style={{ accentColor: "var(--blue)" }} />
                            <input className="b-input" style={{ flex: 1 }}
                              value={tier.tag1} onChange={(e) => updateVolumeTier(i, "tag1", e.target.value)}
                              placeholder="Etiqueta 1" autoComplete="off" />
                          </label>
                          <label className="b-checkbox-row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
                            <input type="checkbox" defaultChecked style={{ accentColor: "var(--blue)" }} />
                            <input className="b-input" style={{ flex: 1 }}
                              value={tier.tag2} onChange={(e) => updateVolumeTier(i, "tag2", e.target.value)}
                              placeholder="Etiqueta 2" autoComplete="off" />
                          </label>
                          <label className="b-checkbox-row" style={{ gap: 8, cursor: "pointer" }}>
                            <input type="checkbox"
                              checked={tier.preselected}
                              onChange={(e) => updateVolumeTier(i, "preselected", e.target.checked)}
                              style={{ accentColor: "var(--blue)" }} />
                            <span style={{ fontSize: 13, color: "var(--text)" }}>Preseleccionado</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  ))}

                  <div style={{ fontSize: 12, color: "var(--text-sub)", background: "var(--bg-hover)", borderRadius: 6, padding: "8px 12px", border: "1px solid var(--border)" }}>
                    Los artículos que superan la cantidad del nivel anterior no tendrán descuento.
                  </div>

                  <button type="button" className="b-btn b-btn-secondary"
                    onClick={addVolumeTier} style={{ alignSelf: "flex-start" }}>
                    + Agregar nivel
                  </button>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                CHEAPEST — Card "Niveles"
            ──────────────────────────────────────────────── */}
            {templateId === "cheapest_item" && (
              <div className="b-card">
                <div className="b-card-header">Niveles</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* Descuento sobre */}
                  <div>
                    <label className="b-label">Descuento sobre:</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="radio" name="discountOnItem" value="cheapest"
                          checked={discountOnItem === "cheapest"}
                          onChange={() => setDiscountOnItem("cheapest")}
                          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Artículo más barato</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                        <input type="radio" name="discountOnItem" value="most_expensive"
                          checked={discountOnItem === "most_expensive"}
                          onChange={() => setDiscountOnItem("most_expensive")}
                          style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Artículo más caro</span>
                      </label>
                    </div>
                  </div>

                  {cheapestTiers.map((tier, i) => (
                    <div key={i} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Nivel {i + 1}</span>
                        <button type="button" onClick={() => removeCheapestTier(i)}
                          style={{ width: 20, height: 20, borderRadius: "50%", background: "#ff4d4d", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 14, padding: 0 }}>
                          ×
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label">Número de artículos requeridos</label>
                            <input className="b-input" type="number" min="1"
                              value={tier.requiredQty} onChange={(e) => updateCheapestTier(i, "requiredQty", e.target.value)}
                              autoComplete="off" />
                          </div>
                          <div>
                            <label className="b-label">Número de artículos con descuento</label>
                            <input className="b-input" type="number" min="1"
                              value={tier.discountedQty} onChange={(e) => updateCheapestTier(i, "discountedQty", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label">Tipo</label>
                            <select className="b-select"
                              value={tier.discountType} onChange={(e) => updateCheapestTier(i, "discountType", e.target.value)}>
                              <option value="percentage">Porcentaje</option>
                              <option value="fixed_amount">Monto fijo</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label">Valor</label>
                            <input className="b-input" type="number" min="0"
                              value={tier.discountValue} onChange={(e) => updateCheapestTier(i, "discountValue", e.target.value)}
                              autoComplete="off" />
                          </div>
                        </div>
                        <div>
                          <label className="b-label">Texto de la etiqueta</label>
                          <input className="b-input"
                            value={tier.label} onChange={(e) => updateCheapestTier(i, "label", e.target.value)}
                            autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  ))}

                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <button type="button" className="b-btn b-btn-secondary"
                      onClick={addCheapestTier}>
                      + Agregar nivel
                    </button>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                      <input type="checkbox" style={{ accentColor: "var(--blue)" }} />
                      <span style={{ fontSize: 13, color: "var(--text)" }}>Multiplicar el último nivel</span>
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
                      <label className="b-label">Descuento por:</label>
                      <select className="b-select" name="cartDiscountBy"
                        value={cartDiscountBy} onChange={(e) => setCartDiscountBy(e.target.value)}>
                        <option value="cart_value">Valor del carrito</option>
                        <option value="quantity">Cantidad</option>
                      </select>
                    </div>
                    <div>
                      <label className="b-label">Tipo de descuento:</label>
                      <select className="b-select" name="cartDiscountType"
                        value={cartDiscountType} onChange={(e) => setCartDiscountType(e.target.value)}>
                        <option value="percentage">Porcentaje</option>
                        <option value="fixed_amount">Monto fijo</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 4 }}>Niveles</div>

                  {cartTiers.map((tier, i) => (
                    <div key={i} className="b-card" style={{ background: "var(--bg-hover)" }}>
                      <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>Nivel {i + 1}</span>
                        <button type="button" onClick={() => removeCartTier(i)}
                          style={{ width: 20, height: 20, borderRadius: "50%", background: "#ff4d4d", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 14, padding: 0 }}>
                          ×
                        </button>
                      </div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <label className="b-label">Valor del carrito requerido</label>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 13, color: "var(--text-sub)", fontWeight: 500 }}>$</span>
                              <input className="b-input" type="number" min="0" step="0.01"
                                value={tier.threshold} onChange={(e) => updateCartTier(i, "threshold", e.target.value)}
                                autoComplete="off" />
                            </div>
                          </div>
                          <div>
                            <label className="b-label">Valor de descuento</label>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ fontSize: 13, color: "var(--text-sub)", fontWeight: 500 }}>%</span>
                              <input className="b-input" type="number" min="0"
                                value={tier.discountValue} onChange={(e) => updateCartTier(i, "discountValue", e.target.value)}
                                autoComplete="off" />
                            </div>
                          </div>
                        </div>

                        {/* Currency chips (visual only) */}
                        <div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 6 }}>Agregar moneda</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {CURRENCY_CHIPS.map((code) => (
                              <span key={code} style={{
                                fontSize: 11, padding: "2px 7px", borderRadius: 4,
                                background: "var(--bg)", border: "1px solid var(--border)",
                                color: "var(--text-sub)", cursor: "pointer", userSelect: "none",
                              }}>
                                {code}
                              </span>
                            ))}
                          </div>
                        </div>

                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                          <input type="checkbox" style={{ accentColor: "var(--blue)" }} />
                          <span style={{ fontSize: 13, color: "var(--text)" }}>Valor máximo de descuento</span>
                        </label>

                        <div>
                          <label className="b-label">Texto de la etiqueta de nivel</label>
                          <input className="b-input"
                            value={tier.label} onChange={(e) => updateCartTier(i, "label", e.target.value)}
                            autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  ))}

                  <button type="button" className="b-btn b-btn-secondary"
                    onClick={addCartTier} style={{ alignSelf: "flex-start" }}>
                    + Agregar nivel
                  </button>
                </div>
              </div>
            )}

            {/* ────────────────────────────────────────────────
                VOLUME — Suscripción card
            ──────────────────────────────────────────────── */}
            {templateId === "volume" && (
              <div className="b-card">
                <div className="b-card-header">Suscripción</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                    <input type="checkbox" style={{ accentColor: "var(--blue)" }} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>
                      Mostrar opciones de suscripción en el widget
                    </span>
                  </label>
                  <div style={{ fontSize: 12, color: "var(--blue)", background: "var(--bg-hover)", borderRadius: 6, padding: "8px 12px", border: "1px solid var(--border)" }}>
                    Sugerencia: Integra con Appstle para mostrar opciones de suscripción junto con el descuento por volumen.
                  </div>
                </div>
              </div>
            )}

            {/* ── Código de descuento (all templates) ── */}
            <div className="b-card">
              <div className="b-card-header">Código de descuento</div>
              <div className="b-card-body">
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" style={{ accentColor: "var(--blue)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>
                    Agregue un código de descuento personalizado
                  </span>
                </label>
              </div>
            </div>

            {/* ── Este descuento se puede combinar con ── */}
            <div className="b-card">
              <div className="b-card-header">Este descuento se puede combinar con</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {templateId === "cart" && (
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                    <input type="checkbox" name="combinesProductDiscounts"
                      checked={combinesProductDiscounts}
                      onChange={(e) => setCombinesProductDiscounts(e.target.checked)}
                      style={{ accentColor: "var(--blue)" }} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>Descuentos de productos</span>
                  </label>
                )}
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name="combinesOrderDiscounts"
                    checked={combinesOrderDiscounts}
                    onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                    style={{ accentColor: "var(--blue)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>Descuentos de pedido</span>
                </label>
                <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                  <input type="checkbox" name="combinesShippingDiscounts"
                    checked={combinesShippingDiscounts}
                    onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                    style={{ accentColor: "var(--blue)" }} />
                  <span style={{ fontSize: 13, color: "var(--text)" }}>Descuentos de envío</span>
                </label>
              </div>
            </div>

          </div>

          {/* ── Right column: Preview / Avance ── */}
          <div style={{ position: "sticky", top: 16 }}>
            {(templateId === "volume" || templateId === "cheapest_item") && (
              <div className="b-card">
                <div className="b-card-header">Avance</div>
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
                <div className="b-card-header">Mostrar descuento en el carrito</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  <CartPreviewSection title="Personalizar el widget de banner" />
                  <CartPreviewSection title="Añadir mensaje de felicitación" />
                  <CartPreviewSection title="Agregar una barra de progreso en el cajón del carrito" />
                </div>
              </div>
            )}
          </div>

        </div>

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, paddingBottom: 32 }}>
          <button type="button" className="b-btn b-btn-secondary"
            onClick={() => void navigate("/app/offers")}>
            Cancelar
          </button>
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary"
            style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
            Guardar borrador
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-primary">
            Publicar
          </button>
        </div>

      </Form>

      <ProductPicker
        open={productPickerOpen}
        onClose={() => setProductPickerOpen(false)}
        title="Seleccionar productos"
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
            <div key={i} style={{
              border: tier.preselected ? "2px solid var(--blue)" : "1px solid var(--border)",
              borderRadius: 6, padding: "8px 10px", background: tier.preselected ? "rgba(0,119,255,0.04)" : "var(--bg)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  {tier.qty ? `${tier.qty}x` : `—`} {tier.label || `Nivel ${i + 1}`}
                </div>
                {tier.tag2 && <div style={{ fontSize: 11, color: "var(--text-sub)" }}>{tier.tag2}</div>}
              </div>
              {tier.tag1 && (
                <span style={{ fontSize: 11, background: "#008060", color: "white", borderRadius: 4, padding: "2px 6px" }}>
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
              <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--text-sub)" }}>Descuento</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
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
        {tiers.map((tier, i) => (
          <div key={i} style={{
            border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px",
            background: "var(--bg)", fontSize: 12, color: "var(--text)",
          }}>
            {tier.label || `Compra ${tier.requiredQty}, obtén ${tier.discountedQty} con descuento`}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Cart right panel accordion section ──────────────────────────────────────

function CartPreviewSection({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 0", fontSize: 13, color: "var(--text)", fontWeight: 500, textAlign: "left",
        }}
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
          Configura esta sección para personalizar la apariencia en el carrito.
        </div>
      )}
    </div>
  );
}
