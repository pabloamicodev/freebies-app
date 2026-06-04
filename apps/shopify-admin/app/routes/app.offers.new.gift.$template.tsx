/**
 * Gift Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/gift/bxgy  /bogo  /free-sample  /cart-value  /tiered  /scratch
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";
import { SubconditionModal } from "../components/SubconditionModal.js";
import { SubconditionCard } from "../components/SubconditionCard.js";
import { GIFT_SUBCONDITIONS, SUB_FORMS } from "../components/subconditions/index.js";
import type { SubconditionId } from "../components/subconditions/index.js";

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

const CURRENCIES = ["AFN","AUD","AWG","BBD","BZD","CAD","CNY","DJF","EUR","FKP","GBP","HKD","JPY","MXN","USD"];

// ─── Local icons (only used within this file) ─────────────────────────────────
function ICheck()    { return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>; }
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
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id;
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

  await db.insert(offerConditions).values({ shopId, offerId: newOffer.id, scope: "main", conditionType, operator: "gte", value: conditionValue, sortOrder: 0, isEnabled: true });
  await db.insert(offerRewards).values({ shopId, offerId: newOffer.id, rewardType: "product_gift", discountType: discountType as "free" | "percentage" | "fixed_amount" | "fixed_price" | "cheapest_item_free" | "most_expensive_item_discount", value: { amount: rewardAmount, currencyCode: "USD" }, target: { scope: "cart", variantIds: rewardProducts }, quantity: giftCount, isAutoAdd, isCustomerSelectable: !isAutoAdd, trackMode: "product", sortOrder: 0 });
  await db.insert(offerCombinationPolicies).values({ shopId, offerId: newOffer.id, combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true, combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true, stopLowerPriority: false, giftValueCountsForOtherOffers: false });

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Summary sidebar ──────────────────────────────────────────────────────────
function SummaryDot({ checked }: { checked: boolean }) {
  return (
    <div style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, marginTop: 1, background: checked ? "#008060" : "transparent", border: `2px solid ${checked ? "#008060" : "var(--border)"}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {checked && <ICheck />}
    </div>
  );
}

function SummaryRow({ checked, label, lines = [], optional = false }: { checked: boolean; label: string; lines?: string[]; optional?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <SummaryDot checked={checked} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: optional && !checked ? "var(--text-sub)" : "var(--text)" }}>
          {label}{optional && !checked && <span style={{ fontWeight: 400 }}> (opcional)</span>}
        </div>
        {lines.map((l, i) => (
          <div key={i} style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 1 }}>{l}</div>
        ))}
        {!checked && lines.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--blue)", marginTop: 1 }}>+ Haga clic para agregar</div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function NewGiftOfferPage() {
  const navigate = useNavigate();
  const { template: slug = "scratch" } = useParams<{ template: string }>();
  const templateId = SLUG_TO_TEMPLATE[slug] ?? "scratch";
  const preset = TEMPLATE_PRESETS[templateId];
  const conditionType: ConditionType = preset?.conditionType ?? "cart_value";

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
  const [trackMode, setTrackMode]           = useState("product");
  const [conditionProducts, setConditionProducts] = useState<string[]>([]);
  const [condPickerOpen, setCondPickerOpen] = useState(false);

  // ── Block 3: Subconditions ──
  const [subModalOpen, setSubModalOpen]   = useState(false);
  const [activeSubs, setActiveSubs]       = useState<SubconditionId[]>([]);

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
    return `${conditionProducts.length} producto(s) seleccionados`;
  }

  function appliesToLabel() {
    if (appliesTo === "any_product") return "Aplica para cualquier producto";
    if (appliesTo === "specific_products") return `${conditionProducts.length} producto(s) seleccionados`;
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
        <input type="hidden" name="conditionType"      value={conditionType} />
        <input type="hidden" name="conditionProducts"  value={JSON.stringify(conditionProducts)} />
        <input type="hidden" name="rewardProducts"     value={JSON.stringify(rewardProducts)} />
        <input type="hidden" name="isAutoAdd"          value={String(isAutoAdd)} />
        <input type="hidden" name="minAmount"          value={minAmount} />
        <input type="hidden" name="maxAmount"          value={maxAmount} />
        <input type="hidden" name="appliesTo"          value={appliesTo} />
        <input type="hidden" name="priority"           value={priority} />

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
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Oferta condición principal</div>

              <div className="b-card">
                <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{CONDITION_TYPE_LABEL[conditionType]}</span>
                  <button type="button" style={{ background: "#ff4d4d", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>×</button>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* cart_value / cart_value_multiplier */}
                  {(conditionType === "cart_value" || conditionType === "cart_value_multiplier") && (
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
                          <option value="specific_products">productos seleccionados</option>
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
                          <input className="b-input" type="number" autoComplete="off" placeholder="0" />
                        </div>
                      </div>
                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)}>
                          <option value="any_product">cualquier producto</option>
                          <option value="specific_products">productos seleccionados</option>
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
                      {giftsMatchProducts && (
                        <div style={{ marginLeft: 26, display: "flex", flexDirection: "column", gap: 6 }}>
                          {[{ v: "variant", l: "Seguimiento por variante" }, { v: "product", l: "Seguimiento por producto" }].map((opt) => (
                            <label key={opt.v} className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                              <input type="radio" name="trackMode" value={opt.v} checked={trackMode === opt.v} onChange={() => setTrackMode(opt.v)} style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                              <span style={{ fontSize: 13 }}>{opt.l}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" value={trackMode} onChange={(e) => setTrackMode(e.target.value)}>
                          <option value="product">productos seleccionados</option>
                          <option value="variant">variantes seleccionadas</option>
                          <option value="any">cualquier producto</option>
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
                <button type="button" className="b-btn b-btn-primary b-btn-sm">
                  + Agregar condición principal
                </button>
                <div style={{ fontSize: 12, color: "var(--text-sub)" }}>
                  La cantidad del carrito y la condición del valor del carrito se pueden combinar
                </div>
              </div>
            </div>

            {/* ── Block 3: Subconditions ── */}
            <div>
              {activeSubs.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Subcondición de oferta</div>
                  {activeSubs.map((id) => {
                    const SubForm = SUB_FORMS[id];
                    const def = GIFT_SUBCONDITIONS.find((s) => s.id === id)!;
                    return (
                      <SubconditionCard key={id} def={def} onRemove={() => setActiveSubs((prev) => prev.filter((x) => x !== id))}>
                        <SubForm />
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
                              <option value="free">Gratis (100%)</option>
                              <option value="percentage">Porcentaje</option>
                              <option value="fixed_amount">Monto fijo</option>
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
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 6 }}>
                          <input type="radio" name="_autoAddRadio" checked={isAutoAdd} onChange={() => setIsAutoAdd(true)}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                          <span style={{ fontSize: 13, color: "var(--text)" }}>Automáticamente todos los regalos</span>
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
                  <div>
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
          <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Help card */}
            <div className="b-card">
              <div className="b-card-body" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: "#e8f4fd", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2c6ecb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>¿Necesitas ayuda para crear ofertas?</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 10 }}>Chatea con nosotros para obtener ayuda</div>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm">Chatea con nosotros</button>
                </div>
              </div>
            </div>

            {/* Summary card */}
            <div className="b-card">
              <div className="b-card-header">Resumen</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                <SummaryRow
                  checked={hasName}
                  label="Información básica"
                  lines={hasName ? [
                    publicTitle || internalName,
                    `Empieza en ${formatDate(startsAt)}`,
                  ] : []}
                />

                <div style={{ width: 1, height: 1, borderLeft: "1.5px dashed var(--border)", marginLeft: 9 }} />

                <SummaryRow
                  checked={true}
                  label="Condición principal"
                  lines={[conditionSummaryLine(), appliesToLabel()]}
                />

                <div style={{ width: 1, height: 1, borderLeft: "1.5px dashed var(--border)", marginLeft: 9 }} />

                <SummaryRow
                  checked={activeSubs.length > 0}
                  label="Subcondición"
                  optional
                  lines={subSummaryLines}
                />

                <div style={{ width: 1, height: 1, borderLeft: "1.5px dashed var(--border)", marginLeft: 9 }} />

                <SummaryRow
                  checked={hasRewardProducts}
                  label="Regalo"
                  optional
                  lines={hasRewardProducts ? [`${rewardProducts.length} producto(s) seleccionados`] : []}
                />

              </div>
            </div>
          </div>

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
      <SubconditionModal
        open={subModalOpen}
        active={activeSubs}
        types={GIFT_SUBCONDITIONS}
        onClose={() => setSubModalOpen(false)}
        onConfirm={(ids) => setActiveSubs(ids)}
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
