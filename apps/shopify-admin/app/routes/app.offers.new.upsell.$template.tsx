/**
 * Upsell Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/upsell/checkout   → Checkout upsell
 *         /app/offers/new/upsell/fbt         → Frequently Bought Together
 *         /app/offers/new/upsell/thank-you   → Thank You page upsell
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
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

  const hasName = Boolean(internalName.trim());
  const hasProducts = upsellProducts.length > 0;

  // ── Page title ───────────────────────────────────────────────────────────
  const PAGE_TITLE: Record<string, string> = {
    "checkout": "Crear venta adicional en Checkout",
    "fbt": "Crear venta adicional",
    "thank-you": "Crear una página de agradecimiento para aumentar las ventas",
  };
  const pageTitle = PAGE_TITLE[templateSlug] ?? "Crear venta adicional";

  // ── Helpers ──────────────────────────────────────────────────────────────
  const isCheckout = templateSlug === "checkout";
  const isFbt = templateSlug === "fbt";
  const isThankYou = templateSlug === "thank-you";

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

      {/* ── Info banner ── */}
      {!infoBannerDismissed && (
        <div style={{
          background: "var(--blue-bg, #e8f0fe)", border: "1px solid var(--blue-border, #b3cdf9)",
          borderRadius: 8, padding: "12px 16px", marginBottom: 20,
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              Recorrido rápido: Cómo crear una venta adicional
            </div>
            <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
              <a href="#" style={{ color: "var(--blue)", textDecoration: "underline" }}>
                Familiarícese con nuestro recorrido o aprenda más en nuestro documento de orientación.
              </a>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setInfoBannerDismissed(true)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1, color: "var(--text-sub)", padding: 0, flexShrink: 0 }}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
      )}

      <Form method="POST">
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
            <div className="b-card">
              <div className="b-card-header">Información de venta adicional</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Nombre de venta adicional</label>
                  <input
                    id="internalName" className="b-input" name="internalName"
                    value={internalName} onChange={(e) => setInternalName(e.target.value)}
                    autoComplete="off" placeholder="e.g., Checkout Upsell #1"
                  />
                  <div className="b-help">Sólo para uso interno, no para mostrar a los clientes.</div>
                </div>

                {/* FBT-only: widget display fields */}
                {isFbt && (
                  <div className="b-card" style={{ background: "var(--bg-hover, #f9f9f9)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label className="b-label" htmlFor="publicTitle">Título de venta adicional</label>
                        <input
                          id="publicTitle" className="b-input" name="publicTitle"
                          value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                          autoComplete="off" placeholder="e.g., Frequently bought together"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="description">Descripción de venta adicional <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(opcional)</span></label>
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
                    <label className="b-label" htmlFor="startsAt">Hora de inicio</label>
                    <input
                      id="startsAt" className="b-input" type="datetime-local" name="startsAt"
                      value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="endsAt">Hora de finalización</label>
                    <input
                      id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                      value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Card: Activador de venta adicional ── */}
            <div className="b-card">
              <div className="b-card-header">Activador de venta adicional</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {isFbt ? (
                  <>
                    {[
                      { value: "always", label: "Mostrar siempre las ventas adicionales" },
                      { value: "product_selected", label: "Productos seleccionados" },
                      { value: "product_except", label: "Todos excepto productos seleccionados" },
                      { value: "collection_selected", label: "Colecciones/tipos/proveedores seleccionados" },
                      { value: "collection_except", label: "Todos excepto colecciones/tipos/proveedores seleccionados" },
                    ].map(({ value, label }) => (
                      <label key={value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="radio" name="_triggerTypeRadio" value={value}
                          checked={triggerType === value}
                          onChange={() => setTriggerType(value)}
                          style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
                        />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
                      </label>
                    ))}
                    <div className="b-help" style={{ marginTop: 4 }}>
                      La venta adicional siempre se muestra sin ningún disparador.
                    </div>
                  </>
                ) : (
                  <>
                    {[
                      { value: "always", label: "Mostrar siempre las ventas adicionales" },
                      { value: "cart", label: "Activador de carrito" },
                      { value: "product", label: "Activador de producto específico" },
                      { value: "customer", label: "Activador del cliente" },
                    ].map(({ value, label }) => (
                      <label key={value} className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="radio" name="_triggerTypeRadio" value={value}
                          checked={triggerType === value}
                          onChange={() => setTriggerType(value)}
                          style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
                        />
                        <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
                      </label>
                    ))}
                    <div className="b-help" style={{ marginTop: 4 }}>
                      La venta adicional siempre se muestra sin ningún disparador.
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ── Agregar subcondición (dashed) ── */}
            <div className="b-card" style={{ background: "var(--bg)", border: "1.5px dashed var(--border)" }}>
              <div className="b-card-body" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", color: "var(--blue)", cursor: "pointer", fontWeight: 500, fontSize: 14 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                Agregar subcondición
              </div>
            </div>

            {/* ── Card: Método de venta adicional ── */}
            <div className="b-card">
              <div className="b-card-header">Método de venta adicional</div>
              <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* FBT: Widget type selector */}
                {isFbt && (
                  <div>
                    <div className="b-label" style={{ marginBottom: 8 }}>Tipo de widget de venta adicional</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {[
                        { value: "fbt", label: "Comprados juntos con frecuencia" },
                        { value: "product_add_on", label: "Complemento de producto" },
                      ].map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setWidgetType(value)}
                          style={{
                            border: `2px solid ${widgetType === value ? "var(--blue)" : "var(--border)"}`,
                            borderRadius: 8, padding: "14px 12px", background: widgetType === value ? "var(--blue-bg, #e8f0fe)" : "var(--bg)",
                            cursor: "pointer", textAlign: "center", fontSize: 13,
                            fontWeight: widgetType === value ? 600 : 400,
                            color: widgetType === value ? "var(--blue)" : "var(--text)",
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
                  <div className="b-label" style={{ marginBottom: 8 }}>Seleccionar método</div>
                  <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
                    {["manual", "auto", ...(isCheckout ? [] : ["random"])].map((m) => {
                      const labels: Record<string, string> = { manual: "Manual", auto: "Auto", random: "Aleatorio" };
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setUpsellMethod(m)}
                          style={{
                            padding: "8px 16px", fontSize: 13,
                            fontWeight: upsellMethod === m ? 600 : 400,
                            color: upsellMethod === m ? "var(--blue)" : "var(--text-sub)",
                            borderBottom: upsellMethod === m ? "2px solid var(--blue)" : "2px solid transparent",
                            background: "none", border: "none",
                            borderBottomWidth: 2, borderBottomStyle: "solid",
                            borderBottomColor: upsellMethod === m ? "var(--blue)" : "transparent",
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
                    Seleccionar producto de venta adicional
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button" className="b-btn b-btn-secondary"
                      onClick={() => setProductPickerOpen(true)}
                    >
                      Seleccionar productos
                    </button>
                    <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                      {upsellProducts.length} productos seleccionados
                    </span>
                  </div>

                  {/* Checkout: limited qty checkbox */}
                  {isCheckout && (
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginTop: 10 }}>
                      <input type="checkbox" />
                      <div>
                        <div className="b-checkbox-label">Se puede añadir un número limitado de productos de venta adicional.</div>
                      </div>
                    </label>
                  )}

                  {/* FBT: set qty for current item */}
                  {isFbt && (
                    <>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginTop: 10 }}>
                        <input type="checkbox" />
                        <div className="b-checkbox-label">Establecer cantidad para el artículo actual</div>
                      </label>
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                          Cantidad de producto de venta adicional:
                        </div>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 6 }}>
                          <input
                            type="radio" name="_allowCustomerQtyRadio"
                            checked={allowCustomerQty}
                            onChange={() => setAllowCustomerQty(true)}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
                          />
                          <div>
                            <div className="b-checkbox-label">Permitir a los clientes cambiar la cantidad</div>
                            <div className="b-checkbox-help">Los clientes pueden ajustar la cantidad antes de agregar al carrito.</div>
                          </div>
                        </label>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input
                            type="radio" name="_allowCustomerQtyRadio"
                            checked={!allowCustomerQty}
                            onChange={() => setAllowCustomerQty(false)}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
                          />
                          <div>
                            <div className="b-checkbox-label">Cantidad fija</div>
                            <div className="b-checkbox-help">La cantidad está fija y no puede ser cambiada por el cliente.</div>
                          </div>
                        </label>
                      </div>
                    </>
                  )}
                </div>

                {/* Checkout: Discount section (inside method card) */}
                {isCheckout && (
                  <div className="b-card" style={{ background: "var(--bg-hover, #f9f9f9)" }}>
                    <div className="b-card-header" style={{ fontSize: 13 }}>Descuento</div>
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
                        <a href="#" style={{ fontSize: 13, color: "var(--blue)", textDecoration: "none" }}>
                          + Agregar: Descuento de envío
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
                <div className="b-card-header">Descuento</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                    <input
                      type="checkbox" name="discountEnabled"
                      checked={discountEnabled}
                      onChange={(e) => setDiscountEnabled(e.target.checked)}
                    />
                    <div className="b-checkbox-label">Habilitar descuento</div>
                  </label>

                  {discountEnabled && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="discountMinProducts">
                          Número de productos únicos necesarios para el descuento
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
                        <label className="b-label" htmlFor="discountApplyTo">Aplicar descuento a:</label>
                        <select
                          id="discountApplyTo" className="b-select" name="discountApplyTo"
                          value={discountApplyTo}
                          onChange={(e) => setDiscountApplyTo(e.target.value)}
                        >
                          <option value="any">Cualquier artículo</option>
                          <option value="cheapest">Artículo más barato</option>
                          <option value="most_expensive">Artículo más caro</option>
                        </select>
                      </div>
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
                        <a href="#" style={{ fontSize: 13, color: "var(--blue)", textDecoration: "none" }}>
                          + Agregar: Descuento de envío
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
                <div className="b-card-header">Descuento</div>
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
                    <a href="#" style={{ fontSize: 13, color: "var(--blue)", textDecoration: "none" }}>
                      + Agregar: Descuento de envío
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
                  <span>Configuración avanzada (opcional)</span>
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
                      <div className="b-card-header" style={{ fontSize: 13 }}>Código de descuento</div>
                      <div className="b-card-body">
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="checkbox" />
                          <div>
                            <div className="b-checkbox-label">Agregue un código de descuento personalizado</div>
                            <div className="b-checkbox-help">Los clientes pueden ingresar un código de descuento al momento del pago.</div>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Combinations */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
                        Este descuento de venta adicional se puede combinar con
                      </div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10, marginBottom: 8 }}>
                        <input
                          type="checkbox"
                          checked={combinesOrderDiscounts}
                          onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                        />
                        <div className="b-checkbox-label">Descuentos de pedido</div>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input
                          type="checkbox"
                          checked={combinesShippingDiscounts}
                          onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                        />
                        <div className="b-checkbox-label">Descuentos de envío</div>
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
                  <div className="b-card-header">Código de descuento</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" />
                      <div>
                        <div className="b-checkbox-label">Agregue un código de descuento personalizado</div>
                        <div className="b-checkbox-help">Los clientes pueden ingresar un código de descuento al momento del pago.</div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="b-card">
                  <div className="b-card-header">Este descuento de venta adicional se puede combinar con</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)}
                      />
                      <div className="b-checkbox-label">Descuentos de pedido</div>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)}
                      />
                      <div className="b-checkbox-label">Descuentos de envío</div>
                    </label>
                  </div>
                </div>
              </>
            )}

            {/* Checkout target (hidden field, shown as select for checkout) */}
            {isCheckout && (
              <div className="b-card">
                <div className="b-card-header">Superficie de checkout</div>
                <div className="b-card-body">
                  <label className="b-label" htmlFor="checkoutTarget">Objetivo de checkout</label>
                  <select
                    id="checkoutTarget" className="b-select" name="checkoutTarget"
                    value={checkoutTarget}
                    onChange={(e) => setCheckoutTarget(e.target.value)}
                  >
                    <option value="">Seleccionar superficie</option>
                    <option value="checkout">Checkout</option>
                    <option value="post_purchase">Post-compra</option>
                    <option value="cart">Carrito</option>
                  </select>
                </div>
              </div>
            )}

          </div>

          {/* ── Right column ── */}
          <OfferSummarySidebar
            helpCard={null}
            aboveSummary={isFbt ? (
              <div className="b-card">
                <div className="b-card-header">Avance</div>
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
                          Seleccione productos para ver una vista previa
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
                      <div style={{ fontSize: 12, color: "var(--blue)", fontWeight: 500 }}>
                        {discountType === "percentage" ? `${discountValue}% OFF` : `$${discountValue} OFF`}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : undefined}
            steps={[
              {
                label: "Información básica",
                checked: hasName,
                items: hasName ? [
                  { text: internalName },
                  { text: `Empieza ${new Date(startsAt).toLocaleDateString("es-ES", { month: "short", day: "numeric", year: "numeric" })}` },
                ] : undefined,
              },
              {
                label: "Activador de venta adicional",
                checked: true,
                items: [{ text: triggerType === "always" ? "Sin disparador / Mostrar siempre" : triggerType }],
              },
              {
                label: "Método de venta adicional",
                checked: hasProducts,
                items: hasProducts ? [{ text: `${upsellProducts.length} producto(s) seleccionados` }] : undefined,
              },
            ]}
          />

        </div>

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, paddingBottom: 32 }}>
          <button
            type="button" className="b-btn b-btn-secondary"
            onClick={() => void navigate("/app/offers")}
          >
            Cancelar
          </button>
          <button
            type="submit" name="intent" value="draft" className="b-btn b-btn-secondary"
            style={{ background: "var(--bg-hover)", border: "1px solid var(--border)" }}
          >
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
        title="Seleccionar productos de venta adicional"
        allowMultiple
        selectedIds={upsellProducts}
        onSelect={(gids) => setUpsellProducts(gids)}
      />

    </div>
  );
}

