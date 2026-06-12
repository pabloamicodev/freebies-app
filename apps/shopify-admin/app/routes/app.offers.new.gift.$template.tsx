/**
 * Gift Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/gift/bxgy  /bogo  /free-sample  /cart-value  /tiered  /scratch
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { SUPPORTED_CURRENCIES } from "@promo/shared-types";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";
import { SubconditionModal } from "../components/SubconditionModal.js";
import { SubconditionCard } from "../components/SubconditionCard.js";
import type { MainConditionType } from "../components/MainConditionModal.js";
import { MainConditionModal } from "../components/MainConditionModal.js";
import { GIFT_SUBCONDITIONS, SUB_FORMS } from "../components/subconditions/index.js";
import type { SubconditionId } from "../components/subconditions/index.js";
import { OfferSummarySidebar } from "../components/OfferSummarySidebar.js";
import { IconCondition, IconSettings } from "../components/Icons.js";

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
  specific_product:       "Condición de producto específico",
  cart_value:             "Condición del valor del carrito",
  cart_quantity:          "Condición de cantidad del carrito",
  cart_value_multiplier:  "Condición del valor escalonado",
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
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();
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

  let newOffer: { id: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateName = attempt === 0 ? internalName : `${internalName} (${attempt + 1})`;
    try {
      [newOffer] = await db.insert(offers).values({
        shopId, type: "gift", status,
        internalName: candidateName, publicTitle, priority,
        startsAt: startsAt ? new Date(startsAt) : new Date(),
        endsAt: endsAt ? new Date(endsAt) : null,
      }).returning({ id: offers.id });
      break;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }
  if (!newOffer) return { error: "Failed to create offer" };

  // Main condition
  await db.insert(offerConditions).values({ shopId, offerId: newOffer.id, scope: "main", conditionType, operator: "gte", value: conditionValue, sortOrder: 0, isEnabled: true });

  // Subconditions
  const subconditionsJson = (formData.get("subconditions") as string) || "{}";
  let subconditions: Record<string, Record<string, unknown>> = {};
  try { subconditions = JSON.parse(subconditionsJson) as Record<string, Record<string, unknown>>; } catch {}
  let subSortOrder = 1;
  for (const [subId, subVal] of Object.entries(subconditions)) {
    if (!subVal || Object.keys(subVal).length === 0) continue;
    await db.insert(offerConditions).values({ shopId, offerId: newOffer.id, scope: "sub", conditionType: subId, operator: "eq", value: subVal as Record<string, unknown>, sortOrder: subSortOrder++, isEnabled: true });
  }

  await db.insert(offerRewards).values({ shopId, offerId: newOffer.id, rewardType: "product_gift", discountType: discountType as "free" | "percentage" | "fixed_amount" | "fixed_price" | "cheapest_item_free" | "most_expensive_item_discount", value: { amount: rewardAmount, currencyCode: "USD" }, target: { scope: "cart", variantIds: rewardProducts }, quantity: giftCount, isAutoAdd, isCustomerSelectable: !isAutoAdd, trackMode: "product", sortOrder: 0 });
  await db.insert(offerCombinationPolicies).values({ shopId, offerId: newOffer.id, combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true, stopLowerPriority: false, giftValueCountsForOtherOffers: false });

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

  // ── Block 1: Offer info ──
  const [internalName, setInternalName] = useState(preset?.internalName ?? "");
  const [publicTitle, setPublicTitle]   = useState(preset?.publicTitle ?? "");
  const [startsAt, setStartsAt]         = useState(() => new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt]             = useState("");

  // ── Block 2: Main condition ──
  const [minAmount, setMinAmount]           = useState("500");
  const [maxAmount, setMaxAmount]           = useState("0.00");
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);
  const [appliesTo, setAppliesTo]           = useState("any_product");
  const [minQty, setMinQty]                 = useState(1);
  const [multiplyGifts, setMultiplyGifts]   = useState(false);
  const [giftsMatchProducts, setGiftsMatchProducts] = useState(preset?.giftsMatchProducts ?? false);
  const isBogo = templateId === "bogo"; // BOGO: auto-add disabled, gifts match by default
  const [trackMode, setTrackMode]           = useState("product");
  const [conditionProducts, setConditionProducts] = useState<string[]>([]);
  const [condPickerOpen, setCondPickerOpen] = useState(false);

  // ── Block 3: Subconditions ──
  const [subModalOpen, setSubModalOpen]   = useState(false);
  const [activeSubs, setActiveSubs]       = useState<SubconditionId[]>([]);
  const [subValues, setSubValues]         = useState<Record<string, unknown>>({});

  // ── Main condition modal (scratch template) ──
  const [mainCondModalOpen, setMainCondModalOpen] = useState(false);
  const [selectedMainCond, setSelectedMainCond] = useState<MainConditionType>(conditionType);

  // ── Block 4: Gifts ──
  const [giftTab, setGiftTab]             = useState<"product" | "shipping">("product");
  const [discountType, setDiscountType]   = useState("percentage");
  const [discountValue, setDiscountValue] = useState("100");
  const [isAutoAdd, setIsAutoAdd]         = useState(false);
  const [giftCount, setGiftCount]         = useState(1);
  const [rewardProducts, setRewardProducts] = useState<string[]>([]);
  const [rewardPickerOpen, setRewardPickerOpen] = useState(false);

  // ── Block 5: Advanced ──
  const [advancedOpen, setAdvancedOpen]   = useState(false);
  const [priority, setPriority]           = useState("1");
  const [stopLower, setStopLower]         = useState(false);
  const [giftAppliesOther, setGiftAppliesOther] = useState(false);
  const [addCartMessage, setAddCartMessage]     = useState(false);
  const [offerTodayTitle, setOfferTodayTitle]   = useState("");
  const [addRedirectBtn, setAddRedirectBtn]     = useState(false);

  // ── Derived ──
  const hasName = Boolean(internalName.trim());
  const hasRewardProducts = rewardProducts.length > 0;

  function toggleCurrency(c: string) {
    setSelectedCurrencies((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleDateString("es-ES", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return iso; }
  }

  function conditionSummaryLine() {
    if (conditionType === "cart_value" || conditionType === "cart_value_multiplier") {
      return `Gaste desde $${parseFloat(minAmount || "0").toFixed(2)} para obtener ${giftCount} regalo(s)`;
    }
    if (conditionType === "cart_quantity") {
      return `Comprar ${minQty} artículo(s) para obtener ${giftCount} regalo(s)`;
    }
    return `Compre ${minQty} artículo(s) de productos para obtener ${giftCount} regalo(s)`;
  }

  function appliesToLabel() {
    if (appliesTo === "any_product") return "Aplica para cualquier producto";
    if (appliesTo === "exclude_variants_ids") return "Excepto productos seleccionados";
    if (appliesTo === "exclude_type_vendor_collection") return "Excepto tipos/proveedores/colecciones";
    if (appliesTo === "variants_ids" || appliesTo === "specific_products") return `Se aplica a ${conditionProducts.length} productos seleccionados`;
    if (appliesTo === "type_vendor_collection") return "Se aplica a tipos/proveedores/colecciones seleccionados";
    return appliesTo;
  }

  const subSummaryLines = activeSubs.map((id) => GIFT_SUBCONDITIONS.find((s) => s.id === id)?.name ?? id);

  return (
    <div className="b-page">
      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <button type="button" className="b-btn-plain b-text-sm" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 8 }} onClick={() => void navigate("/app/offers")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          Crear oferta de regalo
        </button>
      </div>

      <Form method="POST">
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

            {/* ── Block 1: Información de la oferta ── */}
            <div className="b-card">
              <div className="b-card-header">Información de la oferta</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Nombre de la oferta</label>
                  <input id="internalName" className="b-input" name="internalName" value={internalName}
                    onChange={(e) => setInternalName(e.target.value)} autoComplete="off" />
                  <div className="b-help">Solo para uso interno, no se muestra a los clientes..</div>
                </div>
                <div>
                  <label className="b-label" htmlFor="publicTitle">Título de la oferta</label>
                  <input id="publicTitle" className="b-input" name="publicTitle" value={publicTitle}
                    onChange={(e) => setPublicTitle(e.target.value)} autoComplete="off" />
                  <div className="b-help">Mostrado a los clientes en la tienda online.</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label className="b-label" htmlFor="startsAt">Hora de inicio</label>
                    <input id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                      value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="endsAt">Hora de finalización</label>
                    <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                      value={endsAt} onChange={(e) => setEndsAt(e.target.value)} placeholder="Hora de finalización" />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Block 2: Oferta condición principal ── */}
            {!isScratch && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Oferta condición principal</div>

              <div className="b-card">
                <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{CONDITION_TYPE_LABEL[conditionType]}</span>
                  <button type="button" style={{ background: "#ff4d4d", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>×</button>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* cart_value */}
                  {conditionType === "cart_value" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label">min.</label>
                          <div style={{ position: "relative" }}>
                            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                            <input className="b-input" type="number" name="minAmount" value={minAmount}
                              onChange={(e) => setMinAmount(e.target.value)}
                              min="0" step="0.01" style={{ paddingLeft: 22 }} autoComplete="off" />
                          </div>
                        </div>
                        <div>
                          <label className="b-label">máx.</label>
                          <div style={{ position: "relative" }}>
                            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                            <input className="b-input" type="number" name="maxAmount" value={maxAmount}
                              onChange={(e) => setMaxAmount(e.target.value)}
                              min="0" step="0.01" style={{ paddingLeft: 22, paddingRight: 28 }} autoComplete="off" />
                            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--text-sub)" }}>%</span>
                          </div>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Agregar moneda</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {CURRENCIES.map((c) => (
                            <button key={c} type="button" onClick={() => toggleCurrency(c)} style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1.5px solid ${selectedCurrencies.includes(c) ? "var(--blue)" : "var(--border)"}`, background: selectedCurrencies.includes(c) ? "var(--blue-light)" : "var(--bg)", color: selectedCurrencies.includes(c) ? "var(--blue)" : "var(--text-sub)", transition: "all 0.12s" }}>
                              {c}
                            </button>
                          ))}
                          <button type="button" style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text-sub)" }}>···</button>
                        </div>
                      </div>

                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">cualquier producto</option>
                          <option value="exclude_variants_ids">todos excepto productos seleccionados</option>
                          <option value="exclude_type_vendor_collection">todos excepto tipos/proveedores/colecciones seleccionados</option>
                          <option value="specific_products">productos seleccionados</option>
                          <option value="type_vendor_collection">productos en tipos/proveedores/colecciones seleccionados</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* cart_value_multiplier */}
                  {conditionType === "cart_value_multiplier" && (
                    <>
                      <div>
                        <label className="b-label">Multiplicar el valor base</label>
                        <div style={{ position: "relative", maxWidth: 280 }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>$</span>
                          <input className="b-input" type="number" name="minAmount" value={minAmount}
                            onChange={(e) => setMinAmount(e.target.value)}
                            min="0" step="0.01" style={{ paddingLeft: 22 }} autoComplete="off" placeholder="0.00" />
                        </div>
                        <div className="b-help">
                          Por ejemplo: cuando el valor base se establece en $100, el cliente recibirá 1 regalo cuando el valor del carrito sea superior a $100, 2 obsequios cuando sea superior a $200.
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ color: "var(--text-sub)", display: "flex" }}>
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 5.275v-1.025c0-.69.56-1.25 1.25-1.25h4.5c.69 0 1.25.56 1.25 1.25v1.025c0 .448-.24.862-.63 1.085l-.43.246.866 3.894h.694c.69 0 1.25.56 1.25 1.25v1c0 .69-.56 1.25-1.25 1.25h-2.781l-.48 2.873a.75.75 0 0 1-1.479 0l-.479-2.873h-2.781c-.69 0-1.25-.56-1.25-1.25v-1c0-.69.56-1.25 1.25-1.25h.694l.866-3.894-.43-.246a1.25 1.25 0 0 1-.63-1.085Z"/></svg>
                        </span>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>Agregar moneda</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {CURRENCIES.map((c) => (
                            <button key={c} type="button" onClick={() => toggleCurrency(c)} style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1.5px solid ${selectedCurrencies.includes(c) ? "var(--blue)" : "var(--border)"}`, background: selectedCurrencies.includes(c) ? "var(--blue-light)" : "var(--bg)", color: selectedCurrencies.includes(c) ? "var(--blue)" : "var(--text-sub)", transition: "all 0.12s" }}>
                              {c}
                            </button>
                          ))}
                          <button type="button" style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer", border: "1.5px solid var(--border)", background: "var(--bg)", color: "var(--text-sub)" }}>···</button>
                        </div>
                      </div>

                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">cualquier producto</option>
                          <option value="exclude_variants_ids">todos excepto productos seleccionados</option>
                          <option value="exclude_type_vendor_collection">todos excepto tipos/proveedores/colecciones seleccionados</option>
                          <option value="specific_products">productos seleccionados</option>
                          <option value="type_vendor_collection">productos en tipos/proveedores/colecciones seleccionados</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* cart_quantity */}
                  {conditionType === "cart_quantity" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label">min.</label>
                          <input className="b-input" type="number" name="minQty" value={minQty}
                            onChange={(e) => setMinQty(parseInt(e.target.value) || 1)} min="1" autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label">máx.</label>
                          <input className="b-input" type="number" name="maxQty" autoComplete="off" placeholder="0" />
                        </div>
                      </div>
                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">cualquier producto</option>
                          <option value="exclude_variants_ids">todos excepto productos seleccionados</option>
                          <option value="exclude_type_vendor_collection">todos excepto tipos/proveedores/colecciones seleccionados</option>
                          <option value="specific_products">productos seleccionados</option>
                          <option value="type_vendor_collection">productos en tipos/proveedores/colecciones seleccionados</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* specific_product */}
                  {conditionType === "specific_product" && (
                    <>
                      <div>
                        <label className="b-label">Número de productos requeridos</label>
                        <input className="b-input" type="number" name="minQty" value={minQty}
                          onChange={(e) => setMinQty(parseInt(e.target.value) || 1)}
                          min="1" style={{ maxWidth: 120 }} autoComplete="off" />
                      </div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="multiplyGifts" checked={multiplyGifts} onChange={(e) => setMultiplyGifts(e.target.checked)} />
                        <div>
                          <div className="b-checkbox-label">Multiplica regalos con número de productos</div>
                          <div className="b-checkbox-help">Esta función permite a los clientes obtener más obsequios comprando más productos.</div>
                        </div>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="giftsMatchProducts" checked={giftsMatchProducts} onChange={(e) => setGiftsMatchProducts(e.target.checked)} />
                        <div className="b-checkbox-label">Los regalos serán los mismos que los productos seleccionados.</div>
                      </label>
                      <div style={{ marginLeft: 26, display: "flex", flexDirection: "column", gap: 6 }}>
                        {[{ v: "variant", l: "Seguimiento por variante" }, { v: "product", l: "Seguimiento por producto" }].map((opt) => (
                          <label key={opt.v} className="b-checkbox-row" style={{ cursor: giftsMatchProducts ? "pointer" : "not-allowed", gap: 8, opacity: giftsMatchProducts ? 1 : 0.5 }}>
                            <input type="radio" name="trackMode" value={opt.v} checked={trackMode === opt.v} disabled={!giftsMatchProducts}
                              onChange={() => setTrackMode(opt.v)} style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                            <span style={{ fontSize: 13, color: giftsMatchProducts ? "var(--text)" : "var(--text-sub)" }}>{opt.l}</span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="variants_ids">productos seleccionados</option>
                          <option value="type_vendor_collection">productos en tipos/proveedores/colecciones seleccionados</option>
                        </select>
                      </div>
                      <div>
                        <button type="button" className="b-btn b-btn-secondary" onClick={() => setCondPickerOpen(true)}>Seleccionar productos</button>
                        <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>{conditionProducts.length} productos seleccionados</span>
                      </div>
                    </>
                  )}

                </div>
              </div>

              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" className="b-btn b-btn-primary b-btn-sm" disabled>
                  + Agregar condición principal
                </button>
                <div style={{ fontSize: 12, color: "var(--text-sub)" }}>
                  La cantidad del carrito y la condición del valor del carrito se pueden combinar
                </div>
              </div>
            </div>
            )}

            {/* Scratch: botón para abrir el modal de condición principal */}
            {isScratch && (
              <div className="b-card">
                <div className="b-card-header">Oferta condición principal</div>
                <div className="b-card-body">
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button type="button" className="b-btn b-btn-primary b-btn-sm"
                      onClick={() => setMainCondModalOpen(true)}>
                      + Agregar condición principal
                    </button>
                    <span style={{ fontSize: 12, color: "var(--text-sub)" }}>
                      La cantidad del carrito y la condición del valor del carrito se pueden combinar
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Block 3: Subconditions ── */}
            <div>
              {activeSubs.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Subcondición de oferta</div>
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

              <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
                <div className="b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", color: "var(--blue)", cursor: "pointer", fontWeight: 500, fontSize: 14 }}
                  onClick={() => setSubModalOpen(true)}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", border: "1.5px solid var(--blue)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, lineHeight: 1, flexShrink: 0 }}>+</div>
                  Agregar subcondición
                </div>
              </div>

              {activeSubs.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-sub)" }}>
                  La subcondición combina más condiciones para ofertas como enlaces específicos, mercados, ubicación del cliente, etc. No se requieren subcondiciones.
                </div>
              )}
            </div>

            {/* ── Block 4: Seleccionar regalos ── */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Seleccionar regalos</div>
              <div className="b-card">
                {/* Tabs */}
                <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 16px" }}>
                  {[
                    { key: "product",  label: "Regalo de productos" },
                    { key: "shipping", label: "Descuento de envío como regalo" },
                  ].map((tab) => (
                    <button key={tab.key} type="button" onClick={() => setGiftTab(tab.key as "product" | "shipping")}
                      style={{ padding: "10px 16px 10px", fontSize: 13, fontWeight: giftTab === tab.key ? 600 : 400, color: giftTab === tab.key ? "var(--blue)" : "var(--text-sub)", borderBottom: giftTab === tab.key ? "2px solid var(--blue)" : "2px solid transparent", background: "none", border: "none", borderBottomStyle: "solid", cursor: "pointer" }}>
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {giftTab === "product" && (
                    <>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Tipo de descuento de regalo</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <div>
                            <label className="b-label">Tipo:</label>
                            <select className="b-select" name="discountType" value={discountType} onChange={(e) => setDiscountType(e.target.value)}>
                              <option value="percentage">Porcentaje</option>
                              <option value="fixed_amount">Cantidad</option>
                              <option value="fixed_price">Precio fijo</option>
                            </select>
                          </div>
                          <div>
                            <label className="b-label">Valor:</label>
                            <div style={{ position: "relative" }}>
                              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-sub)" }}>
                                {discountType === "fixed_amount" ? "$" : "%"}
                              </span>
                              <input className="b-input" type="number" name="discountValue" value={discountValue}
                                onChange={(e) => setDiscountValue(e.target.value)}
                                min="0" style={{ paddingLeft: 22 }} autoComplete="off" />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>El cliente recibirá:</div>
                        <label className="b-checkbox-row" style={{ cursor: isBogo ? "not-allowed" : "pointer", gap: 10, marginBottom: 6, opacity: isBogo ? 0.5 : 1 }}>
                          <input type="radio" name="_autoAddRadio" checked={isAutoAdd} disabled={isBogo}
                            onChange={() => setIsAutoAdd(true)}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                          <span style={{ fontSize: 13, color: isBogo ? "var(--text-sub)" : "var(--text)" }}>Automáticamente todos los regalos</span>
                        </label>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="radio" name="_autoAddRadio" checked={!isAutoAdd} onChange={() => setIsAutoAdd(false)}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                          <span style={{ fontSize: 13, color: "var(--text)" }}>Número de regalos que recibirá el cliente</span>
                        </label>
                        {!isAutoAdd && (
                          <input className="b-input" type="number" name="giftCount" value={giftCount}
                            onChange={(e) => setGiftCount(parseInt(e.target.value) || 1)}
                            min="1" style={{ maxWidth: 80, marginTop: 8 }} autoComplete="off" />
                        )}
                        {isAutoAdd && <input type="hidden" name="giftCount" value="1" />}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" className="b-btn b-btn-secondary" onClick={() => setRewardPickerOpen(true)}>
                          Seleccionar regalos
                        </button>
                        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>{rewardProducts.length} productos seleccionados</span>
                      </div>
                    </>
                  )}

                  {giftTab === "shipping" && (
                    <div style={{ textAlign: "center", padding: "24px 0", color: "var(--text-sub)", fontSize: 13 }}>
                      Descuento de envío como regalo — próximamente
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Block 5: Configuración avanzada ── */}
            <div className="b-card">
              <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
                onClick={() => setAdvancedOpen((v) => !v)}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>Configuración avanzada (opcional)</span>
                  <span style={{ color: "var(--text-sub)", display: "flex" }}><IInfo /></span>
                </div>
                <span style={{ color: "var(--text-sub)", display: "flex" }}>{advancedOpen ? <IChevUp /> : <IChevDown />}</span>
              </div>

              {advancedOpen && (
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {/* Funciona con otras ofertas */}
                  <div style={{ position: "relative" }}>
                    <div style={{ position: "absolute", top: 0, right: 0, zIndex: 1 }}>
                      <img src="data:image/svg+xml,%3csvg%20width='36'%20height='36'%20viewBox='0%200%2036%2036'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='%23FFAA00'/%3e%3cpath%20d='M0%200H36V36L0%200Z'%20fill='url(%23paint0_linear_30409_40096)'%20fill-opacity='0.5'/%3e%3cpath%20d='M28.8775%2014.8774C28.8593%2013.9095%2028.481%2012.947%2027.7424%2012.2085L27.3396%2011.8057L25.8059%2013.3395L26.2087%2013.7422C26.8763%2014.4099%2026.8763%2015.492%2026.2088%2016.1596C25.5412%2016.8271%2024.459%2016.8272%2023.7913%2016.1596C23.1237%2015.4919%2023.1238%2014.4099%2023.7914%2013.7422L27.7425%209.79118C28.41%209.12371%2029.4922%209.12366%2030.1597%209.79118C30.8272%2010.4587%2030.8273%2011.541%2030.1598%2012.2085L31.6936%2013.7422C33.2082%2012.2277%2033.2081%209.77202%2031.6935%208.25743C31.2597%207.82368%2030.7489%207.51414%2030.2049%207.32882C29.7756%207.18258%2029.3261%207.11358%2028.8777%207.12222C28.8861%206.67385%2028.8172%206.22419%2028.6711%205.79503C28.4858%205.25118%2028.1762%204.74017%2027.7424%204.30632C26.2278%202.79173%2023.7722%202.79173%2022.2576%204.30632C21.8238%204.74017%2021.5143%205.25123%2021.3289%205.79502C21.1827%206.22428%2021.1138%206.67389%2021.1224%207.12232C20.674%207.11367%2020.2244%207.18258%2019.7951%207.32882C19.2513%207.51409%2018.7403%207.82362%2018.3065%208.25743C16.792%209.77201%2016.7919%2012.2277%2018.3064%2013.7422C18.7403%2014.1761%2019.2513%2014.4856%2019.7951%2014.6709C20.2243%2014.817%2020.6739%2014.8859%2021.1224%2014.8775C21.1138%2015.3259%2021.1827%2015.7755%2021.3289%2016.2047C21.5142%2016.7488%2021.8238%2017.2596%2022.2575%2017.6933C23.7721%2019.2079%2026.2279%2019.2079%2027.7425%2017.6934C28.1762%2017.2596%2028.4857%2016.7485%2028.6711%2016.2047C28.8173%2015.7755%2028.8861%2015.3257%2028.8775%2014.8774ZM22.2577%2012.2085C21.5901%2012.8761%2020.5079%2012.8761%2019.8403%2012.2085C19.1727%2011.5409%2019.1728%2010.4588%2019.8404%209.79118C20.508%209.12356%2021.5901%209.12365%2022.2576%209.79118L23.4663%2010.9999L22.2577%2012.2085ZM25.0001%209.46614L23.7913%208.25743C23.1239%207.58996%2023.1238%206.50774%2023.7914%205.84012C24.4591%205.1725%2025.5411%205.1726%2026.2087%205.84012C26.8762%206.50764%2026.8763%207.58991%2026.2088%208.25743L25.0001%209.46614Z'%20fill='white'/%3e%3cpath%20d='M21.1225%207.12289C21.1407%208.09071%2021.519%209.0532%2022.2576%209.79175L22.6604%2010.1945L24.1941%208.66079L23.7913%208.258C23.1237%207.59038%2023.1237%206.50822%2023.7912%205.84069C24.4588%205.17317%2025.541%205.17307%2026.2087%205.84069C26.8763%206.50832%2026.8762%207.59038%2026.2086%208.258L22.2575%2012.2091C21.59%2012.8765%2020.5078%2012.8766%2019.8403%2012.2091C19.1728%2011.5415%2019.1727%2010.4593%2019.8402%209.79175L18.3064%208.258C16.7918%209.77259%2016.7919%2012.2282%2018.3065%2013.7428C18.7403%2014.1766%2019.2511%2014.4861%2019.7951%2014.6714C20.2244%2014.8177%2020.6739%2014.8867%2021.1223%2014.878C21.1139%2015.3264%2021.1828%2015.7761%2021.3289%2016.2052C21.5142%2016.7491%2021.8238%2017.2601%2022.2576%2017.6939C23.7722%2019.2085%2026.2278%2019.2085%2027.7424%2017.6939C28.1762%2017.2601%2028.4857%2016.749%2028.6711%2016.2052C28.8173%2015.776%2028.8862%2015.3264%2028.8776%2014.8779C29.326%2014.8866%2029.7756%2014.8177%2030.2049%2014.6714C30.7487%2014.4862%2031.2597%2014.1766%2031.6935%2013.7428C33.208%2012.2282%2033.2081%209.77259%2031.6936%208.25801C31.2597%207.82415%2030.7487%207.51462%2030.2049%207.3293C29.7757%207.1832%2029.3261%207.1143%2028.8776%207.12279C28.8862%206.67437%2028.8173%206.22476%2028.6711%205.7955C28.4858%205.25145%2028.1762%204.74065%2027.7424%204.30689C26.2279%202.79231%2023.7721%202.79231%2022.2575%204.30689C21.8238%204.74065%2021.5143%205.2517%2021.3289%205.7955C21.1827%206.22476%2021.1139%206.67452%2021.1225%207.12289ZM27.7423%209.79175C28.4099%209.12413%2029.4921%209.12413%2030.1597%209.79175C30.8273%2010.4594%2030.8272%2011.5414%2030.1596%2012.2091C29.492%2012.8767%2028.4099%2012.8766%2027.7424%2012.2091L26.5337%2011.0004L27.7423%209.79175ZM24.9999%2012.5341L26.2087%2013.7428C26.8761%2014.4103%2026.8762%2015.4925%2026.2086%2016.1601C25.5409%2016.8277%2024.4589%2016.8276%2023.7913%2016.1601C23.1238%2015.4926%2023.1237%2014.4103%2023.7912%2013.7428L24.9999%2012.5341Z'%20fill='white'/%3e%3cdefs%3e%3clinearGradient%20id='paint0_linear_30409_40096'%20x1='18'%20y1='0'%20x2='18'%20y2='36'%20gradientUnits='userSpaceOnUse'%3e%3cstop%20stop-color='white'%20stop-opacity='0'/%3e%3cstop%20offset='1'%20stop-color='white'/%3e%3c/linearGradient%3e%3c/defs%3e%3c/svg%3e" width="36" height="36" alt="feature-plan" />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Funciona con otras ofertas</div>
                    <div>
                      <label className="b-label" htmlFor="priority">Prioridad</label>
                      <input id="priority" className="b-input" type="number" value={priority}
                        onChange={(e) => setPriority(e.target.value)} style={{ maxWidth: 120 }} autoComplete="off" />
                    </div>
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={stopLower} onChange={(e) => setStopLower(e.target.checked)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Detener prioridad más baja</div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Ofertas con prioridad 2, 3,... se detendrá si los clientes cumplen las condiciones de esta oferta</div>
                        </div>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, alignItems: "flex-start" }}>
                        <input type="checkbox" checked={giftAppliesOther} onChange={(e) => setGiftAppliesOther(e.target.checked)} style={{ marginTop: 2 }} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>El regalo se aplicará a otras reglas.</div>
                          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>El valor del regalo se aplicará a otras reglas cuando el precio del regalo sea superior a 0.</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Mensaje del carrito */}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Mensaje del carrito</div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 8 }}>This is applied when offer is displayed on Cart page on your Online Store.</div>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" checked={addCartMessage} onChange={(e) => setAddCartMessage(e.target.checked)} />
                      <span style={{ fontSize: 13, color: "var(--text)" }}>Agregar un mensaje de carrito</span>
                    </label>
                  </div>

                  {/* Oferta de hoy */}
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>oferta de hoy</span>
                      <span style={{ background: "#fef3c7", color: "#92400e", fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 10, border: "1px solid #fbbf24" }}>versión antigua</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 10 }}>
                      La última versión de la oferta Hoy ya está disponible en Boosters. Si todavía está usando esta versión, puede configurar el texto que se muestra y el enlace de redireccionamiento aquí.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label className="b-label">Título de la oferta</label>
                        <input className="b-input" value={offerTodayTitle} onChange={(e) => setOfferTodayTitle(e.target.value)}
                          placeholder="Ingresar título de la oferta" autoComplete="off" />
                        <div className="b-help">If blank, the original title will be used. Changing this won&apos;t affect the original offer title.</div>
                      </div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" checked={addRedirectBtn} onChange={(e) => setAddRedirectBtn(e.target.checked)} />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>Agregar un botón de redireccionamiento</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* ── Right sidebar (sticky) ── */}
          <OfferSummarySidebar
            title={hasName ? (publicTitle || internalName) : undefined}
            startDate={hasName ? formatDate(startsAt) : undefined}
            steps={[
              {
                label: "Información básica",
                checked: hasName,
              },
              {
                label: "Condición principal",
                checked: true,
                items: [
                  { icon: IconCondition, text: conditionSummaryLine() },
                  { icon: IconSettings, text: appliesToLabel() },
                ],
              },
              {
                label: "Subcondición",
                checked: activeSubs.length > 0,
                optional: true,
                items: activeSubs.length > 0
                  ? subSummaryLines.map((l) => ({ text: l }))
                  : undefined,
              },
              {
                label: "Regalo",
                checked: hasRewardProducts,
                items: hasRewardProducts
                  ? [{ text: `${rewardProducts.length} producto(s) seleccionados` }]
                  : undefined,
              },
            ]}
          />

        </div>

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, paddingBottom: 32 }}>
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary">
            Guardar borrador
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-dark">
            Publicar
          </button>
        </div>

      </Form>

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
        title="Seleccionar productos para la condición"
        allowMultiple
        selectedIds={conditionProducts}
        onSelect={(gids) => setConditionProducts(gids)}
      />

      <ProductPicker
        open={rewardPickerOpen}
        onClose={() => setRewardPickerOpen(false)}
        title="Seleccionar regalos"
        allowMultiple
        selectedIds={rewardProducts}
        onSelect={(gids) => setRewardProducts(gids)}
      />

    </div>
  );
}
