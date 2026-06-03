/**
 * Gift Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/gift/bxgy
 *         /app/offers/new/gift/bogo
 *         /app/offers/new/gift/free-sample
 *         /app/offers/new/gift/cart-value
 *         /app/offers/new/gift/tiered
 *         /app/offers/new/gift/scratch
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// ─── Slug → internal template ID ─────────────────────────────────────────────

const SLUG_TO_TEMPLATE: Record<string, string> = {
  "bxgy": "buy_x_get_y",
  "bogo": "bogo",
  "free-sample": "buy_x_gift",
  "cart-value": "cart_value",
  "tiered": "tiered",
  "scratch": "scratch",
  "custom": "scratch",
};

// ─── Template preset defaults ───────────────────────────────────────────────

type ConditionType = "specific_product" | "cart_value" | "cart_quantity" | "cart_value_multiplier";

interface TemplatePreset {
  internalName: string;
  publicTitle: string;
  conditionType: ConditionType;
  label: string;
  giftsMatchProducts?: boolean;
}

const TEMPLATE_PRESETS: Record<string, TemplatePreset> = {
  cart_value: {
    internalName: "Spend X amount to get gift",
    publicTitle: "Spend X amount to get gift(s)",
    conditionType: "cart_value",
    label: "Spend X to get gifts",
  },
  buy_x_gift: {
    internalName: "Free sample with purchase",
    publicTitle: "Free sample with purchase",
    conditionType: "cart_quantity",
    label: "Free sample with purchase",
  },
  bogo: {
    internalName: "BOGO Buy 1 get 1 the same",
    publicTitle: "BOGO (Buy 1 get 1 the same)",
    conditionType: "specific_product",
    label: "BOGO (Buy 1 get 1 same)",
    giftsMatchProducts: true,
  },
  buy_x_get_y: {
    internalName: "BXGY Buy X get Y",
    publicTitle: "BXGY (Buy X get Y)",
    conditionType: "specific_product",
    label: "Buy X get Y",
    giftsMatchProducts: false,
  },
  tiered: {
    internalName: "Spend more get more",
    publicTitle: "Spend more get more",
    conditionType: "cart_value_multiplier",
    label: "Tiered spend with gifts",
  },
};

const CONDITION_TYPE_LABEL: Record<ConditionType, string> = {
  specific_product: "Condición específica del producto",
  cart_value: "Condición de valor del carrito",
  cart_quantity: "Condición de cantidad del carrito",
  cart_value_multiplier: "Condición de valor escalonado",
};

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

  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const intent = formData.get("intent") as string;
  const internalName = (formData.get("internalName") as string)?.trim();
  const publicTitle = (formData.get("publicTitle") as string)?.trim();
  const startsAt = formData.get("startsAt") as string;
  const endsAt = formData.get("endsAt") as string;
  const priority = parseInt(formData.get("priority") as string || "100", 10) || 100;

  if (!internalName || !publicTitle) {
    return { error: "Internal name and public title are required" };
  }

  const conditionType = formData.get("conditionType") as ConditionType;
  const minQty = parseInt(formData.get("minQty") as string || "1", 10) || 1;
  const thresholdAmount = parseFloat(formData.get("thresholdAmount") as string || "500");
  const thresholdCents = Math.round(thresholdAmount * 100);
  const multiplyGifts = formData.get("multiplyGifts") === "on";
  const giftsMatchProducts = formData.get("giftsMatchProducts") === "on";
  const trackMode = (formData.get("trackMode") as string) || "product";
  const conditionProductsJson = (formData.get("conditionProducts") as string) || "[]";
  let conditionProducts: string[] = [];
  try { conditionProducts = JSON.parse(conditionProductsJson) as string[]; } catch {}

  let conditionValue: Record<string, unknown>;
  if (conditionType === "specific_product") {
    conditionValue = {
      minQtyPerProduct: minQty,
      multiplyGifts,
      giftsMatchProducts,
      trackMode,
      appliesTo: "specific_products",
      variantIds: conditionProducts,
    };
  } else if (conditionType === "cart_quantity") {
    conditionValue = {
      minQuantity: minQty,
      appliesTo: "any_product",
      includeGiftValues: false,
    };
  } else {
    conditionValue = {
      thresholdCents,
      currencyCode: "USD",
      appliesTo: "any_product",
      includeGiftValues: false,
    };
  }

  const discountType = (formData.get("discountType") as string) || "free";
  const discountValue = parseFloat(formData.get("discountValue") as string || "100");
  const giftCount = parseInt(formData.get("giftCount") as string || "1", 10) || 1;
  const isAutoAdd = formData.get("isAutoAdd") === "true";
  const rewardProductsJson = (formData.get("rewardProducts") as string) || "[]";
  let rewardProducts: string[] = [];
  try { rewardProducts = JSON.parse(rewardProductsJson) as string[]; } catch {}

  const rewardAmount =
    discountType === "free" ? 100
    : discountType === "percentage" ? discountValue
    : Math.round(discountValue * 100);

  const status = intent === "publish" ? "active" : "draft";

  let newOffer: { id: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateName = attempt === 0 ? internalName : `${internalName} (${attempt + 1})`;
    try {
      [newOffer] = await db
        .insert(offers)
        .values({
          shopId, type: "gift", status,
          internalName: candidateName, publicTitle, priority,
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
    shopId, offerId: newOffer.id, scope: "main",
    conditionType, operator: "gte", value: conditionValue, sortOrder: 0, isEnabled: true,
  });

  await db.insert(offerRewards).values({
    shopId, offerId: newOffer.id, rewardType: "product_gift",
    discountType: discountType as "free" | "percentage" | "fixed_amount" | "fixed_price" | "cheapest_item_free" | "most_expensive_item_discount",
    value: { amount: rewardAmount, currencyCode: "USD" },
    target: { scope: "cart", variantIds: rewardProducts },
    quantity: giftCount, isAutoAdd, isCustomerSelectable: !isAutoAdd,
    trackMode: "product", sortOrder: 0,
  });

  await db.insert(offerCombinationPolicies).values({
    shopId, offerId: newOffer.id,
    combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
    stopLowerPriority: false, giftValueCountsForOtherOffers: false,
  });

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewGiftOfferPage() {
  const navigate = useNavigate();
  const { template: templateSlug = "scratch" } = useParams<{ template: string }>();

  const templateId = SLUG_TO_TEMPLATE[templateSlug] ?? "scratch";
  const preset = TEMPLATE_PRESETS[templateId];

  // Offer info
  const [internalName, setInternalName] = useState(preset?.internalName ?? "");
  const [publicTitle, setPublicTitle] = useState(preset?.publicTitle ?? "");
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt] = useState("");

  // Condition — initial values driven by template preset
  const conditionType: ConditionType = preset?.conditionType ?? "specific_product";
  const [minQty, setMinQty] = useState(1);
  const [thresholdAmount, setThresholdAmount] = useState("500");
  const [multiplyGifts, setMultiplyGifts] = useState(false);
  const [giftsMatchProducts, setGiftsMatchProducts] = useState(preset?.giftsMatchProducts ?? false);
  const [trackMode, setTrackMode] = useState("product");
  const [conditionProducts, setConditionProducts] = useState<string[]>([]);
  const [conditionPickerOpen, setConditionPickerOpen] = useState(false);

  // Reward
  const [discountType, setDiscountType] = useState("free");
  const [discountValue, setDiscountValue] = useState("100");
  const [giftCount, setGiftCount] = useState(1);
  const [isAutoAdd, setIsAutoAdd] = useState(true);
  const [rewardProducts, setRewardProducts] = useState<string[]>([]);
  const [rewardPickerOpen, setRewardPickerOpen] = useState(false);

  const hasName = Boolean(internalName.trim());
  const hasConditionProducts = conditionProducts.length > 0;
  const hasRewardProducts = rewardProducts.length > 0;

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
        <h1 className="b-page-title">Crear oferta de regalo</h1>
        {preset && (
          <span style={{ fontSize: 13, color: "var(--text-sub)", marginLeft: 2 }}>
            Plantilla: {preset.label}
          </span>
        )}
      </div>

      <Form method="POST">
        <input type="hidden" name="conditionType" value={conditionType} />
        <input type="hidden" name="conditionProducts" value={JSON.stringify(conditionProducts)} />
        <input type="hidden" name="rewardProducts" value={JSON.stringify(rewardProducts)} />
        <input type="hidden" name="isAutoAdd" value={String(isAutoAdd)} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20, alignItems: "start" }}>

          {/* ── Left column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Información de la oferta */}
            <div className="b-card">
              <div className="b-card-header">Información de la oferta</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Nombre de la oferta</label>
                  <input id="internalName" className="b-input" name="internalName"
                    value={internalName} onChange={(e) => setInternalName(e.target.value)}
                    autoComplete="off" placeholder="e.g., BXGY Buy X get Y" />
                  <div className="b-help">Solo para uso interno, no se muestra a los clientes.</div>
                </div>
                <div>
                  <label className="b-label" htmlFor="publicTitle">Título de la oferta</label>
                  <input id="publicTitle" className="b-input" name="publicTitle"
                    value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                    autoComplete="off" placeholder="e.g., BXGY (Buy X get Y)" />
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
                      value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            {/* Oferta condición principal */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
                Oferta condición principal
              </div>

              <div className="b-card">
                <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{CONDITION_TYPE_LABEL[conditionType]}</span>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#ff4d4d", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 14, color: "white", fontWeight: 700 }}>×</div>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>

                  {/* ── specific_product ── */}
                  {conditionType === "specific_product" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="minQty">Número de productos requeridos</label>
                        <input id="minQty" className="b-input" type="number" name="minQty"
                          value={minQty} onChange={(e) => setMinQty(parseInt(e.target.value) || 1)}
                          min="1" style={{ maxWidth: 120 }} autoComplete="off" />
                      </div>

                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="multiplyGifts" checked={multiplyGifts}
                          onChange={(e) => setMultiplyGifts(e.target.checked)} />
                        <div>
                          <div className="b-checkbox-label">Multiplica regalos con número de productos</div>
                          <div className="b-checkbox-help">Esta función permite a los clientes obtener más obsequios comprando más productos.</div>
                        </div>
                      </label>

                      <div>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="checkbox" name="giftsMatchProducts" checked={giftsMatchProducts}
                            onChange={(e) => setGiftsMatchProducts(e.target.checked)} />
                          <div>
                            <div className="b-checkbox-label">Los regalos serán los mismos que los productos seleccionados.</div>
                          </div>
                        </label>

                        {/* Track mode — only visible when giftsMatchProducts is checked */}
                        {giftsMatchProducts && (
                          <div style={{ marginLeft: 26, marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                            <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                              <input type="radio" name="trackMode" value="variant"
                                checked={trackMode === "variant"}
                                onChange={() => setTrackMode("variant")}
                                style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                              <span style={{ fontSize: 13, color: "var(--text)" }}>Seguimiento por variante</span>
                            </label>
                            <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 8 }}>
                              <input type="radio" name="trackMode" value="product"
                                checked={trackMode === "product"}
                                onChange={() => setTrackMode("product")}
                                style={{ accentColor: "var(--blue)", width: 14, height: 14 }} />
                              <span style={{ fontSize: 13, color: "var(--text)" }}>Seguimiento por producto</span>
                            </label>
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" name="trackMode" value={trackMode}
                          onChange={(e) => setTrackMode(e.target.value)}>
                          <option value="product">productos seleccionados</option>
                          <option value="variant">variantes seleccionadas</option>
                          <option value="any">cualquier producto</option>
                        </select>
                      </div>

                      <div>
                        <button type="button" className="b-btn b-btn-secondary"
                          onClick={() => setConditionPickerOpen(true)}>
                          Seleccionar productos
                        </button>
                        <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                          {conditionProducts.length} productos seleccionados
                        </span>
                      </div>
                    </>
                  )}

                  {/* ── cart_value / cart_value_multiplier ── */}
                  {(conditionType === "cart_value" || conditionType === "cart_value_multiplier") && (
                    <div>
                      <label className="b-label" htmlFor="thresholdAmount">Monto mínimo del carrito (USD)</label>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 14, color: "var(--text-sub)", fontWeight: 500 }}>$</span>
                        <input id="thresholdAmount" className="b-input" type="number" name="thresholdAmount"
                          value={thresholdAmount} onChange={(e) => setThresholdAmount(e.target.value)}
                          min="0" step="0.01" style={{ maxWidth: 160 }} autoComplete="off" />
                      </div>
                      <div className="b-help">El carrito debe alcanzar este valor para activar el regalo.</div>
                    </div>
                  )}

                  {/* ── cart_quantity ── */}
                  {conditionType === "cart_quantity" && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="minQtyCart">mín.</label>
                          <input id="minQtyCart" className="b-input" type="number" name="minQty"
                            value={minQty} onChange={(e) => setMinQty(parseInt(e.target.value) || 1)}
                            min="1" autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="maxQty">máx.</label>
                          <input id="maxQty" className="b-input" type="number" name="maxQty"
                            autoComplete="off" placeholder="" />
                        </div>
                      </div>
                      <div>
                        <label className="b-label">La condición se aplicará a:</label>
                        <select className="b-select" name="appliesTo" defaultValue="any_product">
                          <option value="any_product">cualquier producto</option>
                          <option value="specific_products">productos seleccionados</option>
                        </select>
                      </div>
                    </>
                  )}

                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <button type="button" className="b-btn b-btn-primary b-btn-sm"
                  style={{ opacity: 0.6 }} disabled>
                  + Agregar condición principal
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-sub)" }}>
                La cantidad del carrito y la condición del valor del carrito se pueden combinar
              </div>
            </div>

            {/* Agregar subcondición */}
            <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
              <div className="b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", color: "var(--blue)", cursor: "pointer", fontWeight: 500, fontSize: 14 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Agregar subcondición
              </div>
            </div>

            {/* Seleccionar regalos */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Seleccionar regalos</div>
              <div className="b-card">
                <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 16px" }}>
                  <div style={{ padding: "10px 16px 10px 0", fontSize: 13, fontWeight: 600, color: "var(--blue)", borderBottom: "2px solid var(--blue)", cursor: "pointer" }}>
                    Regalo de productos
                  </div>
                  <div style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-sub)", cursor: "pointer" }}>
                    Descuento de envío como regalo
                  </div>
                </div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>Tipo de descuento de regalo</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label className="b-label">Tipo:</label>
                        <select className="b-select" name="discountType" value={discountType}
                          onChange={(e) => setDiscountType(e.target.value)}>
                          <option value="free">Gratis (100%)</option>
                          <option value="percentage">Porcentaje</option>
                          <option value="fixed_amount">Monto fijo</option>
                        </select>
                      </div>
                      {discountType !== "free" && (
                        <div>
                          <label className="b-label">Valor:</label>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                              {discountType === "percentage" ? "%" : "$"}
                            </span>
                            <input className="b-input" type="number" name="discountValue"
                              value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                              min="0" autoComplete="off" />
                          </div>
                        </div>
                      )}
                      {discountType === "free" && <input type="hidden" name="discountValue" value="100" />}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 8 }}>El cliente recibirá:</div>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 6 }}>
                      <input type="radio" name="_autoAddRadio" checked={isAutoAdd}
                        onChange={() => setIsAutoAdd(true)}
                        style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                      <span style={{ fontSize: 13, color: isAutoAdd ? "var(--text-sub)" : "var(--text)" }}>
                        Automáticamente todos los regalos
                      </span>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="radio" name="_autoAddRadio" checked={!isAutoAdd}
                        onChange={() => setIsAutoAdd(false)}
                        style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                      <span style={{ fontSize: 13, color: !isAutoAdd ? "var(--text)" : "var(--text-sub)" }}>
                        Número de regalos que recibirá el cliente
                      </span>
                    </label>
                    {!isAutoAdd && (
                      <input className="b-input" type="number" name="giftCount"
                        value={giftCount} onChange={(e) => setGiftCount(parseInt(e.target.value) || 1)}
                        min="1" style={{ maxWidth: 80, marginTop: 8 }} autoComplete="off" />
                    )}
                    {isAutoAdd && <input type="hidden" name="giftCount" value="1" />}
                  </div>

                  <div>
                    <button type="button" className="b-btn b-btn-secondary"
                      onClick={() => setRewardPickerOpen(true)}
                      style={{ opacity: hasRewardProducts ? 1 : 0.75 }}>
                      Seleccionar regalos
                    </button>
                    <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                      {rewardProducts.length} productos seleccionados
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Configuración avanzada */}
            <div className="b-card">
              <div className="b-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Configuración avanzada (opcional)</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
              <div className="b-card-body">
                <div>
                  <label className="b-label" htmlFor="priority">Prioridad</label>
                  <input id="priority" className="b-input" type="number" name="priority"
                    defaultValue="100" style={{ maxWidth: 120 }} autoComplete="off" />
                  <div className="b-help">Número más bajo = mayor prioridad.</div>
                </div>
              </div>
            </div>

          </div>

          {/* ── Right column: Resumen ── */}
          <div style={{ position: "sticky", top: 16 }}>
            <div className="b-card">
              <div className="b-card-header">Resumen</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <SummaryRow
                  checked={hasName}
                  label="Información básica"
                  detail={hasName ? publicTitle || internalName : undefined}
                  sub={hasName ? `Empieza ${new Date(startsAt).toLocaleDateString("es-ES", { month: "short", day: "numeric", year: "numeric" })}` : undefined}
                />
                <SummaryRow
                  checked={true}
                  label="Condición principal"
                  detail={CONDITION_TYPE_LABEL[conditionType]}
                  sub={
                    conditionType === "specific_product"
                      ? `${hasConditionProducts ? conditionProducts.length + " producto(s) seleccionados" : "Se aplica a 0 productos seleccionados"}`
                      : conditionType === "cart_quantity"
                      ? `Compra de ${minQty} artículo(s) para obtener 1 regalo(s)`
                      : `Mínimo $${thresholdAmount}`
                  }
                  sub2={
                    conditionType === "specific_product" && hasConditionProducts
                      ? `Se aplica a ${conditionProducts.length} producto(s) seleccionados`
                      : undefined
                  }
                />
                <SummaryRow checked={false} label="Subcondición (opcional)" optional />
                <SummaryRow
                  checked={hasRewardProducts}
                  label="Regalo"
                  detail={hasRewardProducts ? `${rewardProducts.length} producto(s) seleccionados` : undefined}
                  optional
                />
              </div>
            </div>
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
        open={conditionPickerOpen}
        onClose={() => setConditionPickerOpen(false)}
        title="Seleccionar productos para la condición"
        allowMultiple selectedIds={conditionProducts}
        onSelect={(gids) => setConditionProducts(gids)}
      />
      <ProductPicker
        open={rewardPickerOpen}
        onClose={() => setRewardPickerOpen(false)}
        title="Seleccionar regalos"
        allowMultiple selectedIds={rewardProducts}
        onSelect={(gids) => setRewardProducts(gids)}
      />

    </div>
  );
}

// ─── Summary row helper ───────────────────────────────────────────────────────

function SummaryRow({
  checked, label, detail, sub, sub2, optional = false,
}: {
  checked: boolean; label: string; detail?: string; sub?: string; sub2?: string; optional?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 1,
        background: checked ? "#008060" : "transparent",
        border: `2px solid ${checked ? "#008060" : "var(--border)"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: optional && !checked ? "var(--text-sub)" : "var(--text)" }}>
          {label}{optional && !checked && <span style={{ fontWeight: 400 }}> (opcional)</span>}
        </div>
        {detail && <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 1 }}>{detail}</div>}
        {sub && <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{sub}</div>}
        {sub2 && <div style={{ fontSize: 12, color: "var(--text-sub)" }}>{sub2}</div>}
        {!checked && !detail && (
          <div style={{ fontSize: 12, color: "var(--blue)", marginTop: 1 }}>+ Haga clic para agregar</div>
        )}
      </div>
    </div>
  );
}
