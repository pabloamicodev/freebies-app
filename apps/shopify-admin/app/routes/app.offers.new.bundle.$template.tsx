/**
 * Bundle Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/bundle/classic-bundle → Classic Bundle wizard
 *         /app/offers/new/bundle/mix-match      → Mix & Match wizard
 *         /app/offers/new/bundle/bundle-page    → Bundle Page wizard
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import {
  offers, offerCombinationPolicies,
  bundleDefinitions, bundleSteps, bundleTiers, shops,
} from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ProductPicker } from "../components/ProductPicker.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// ─── Slug → internal bundle type ─────────────────────────────────────────────

const SLUG_TO_TEMPLATE: Record<string, string> = {
  "classic-bundle": "classic",
  "mix-match": "mix_match",
  "bundle-page": "bundle_page",
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
  const description = (formData.get("description") as string)?.trim() || null;
  const startsAt = formData.get("startsAt") as string;
  const endsAt = formData.get("endsAt") as string;
  const bundleType = formData.get("bundleType") as string;
  const discountType = (formData.get("discountType") as string) || "percentage";
  const _discountValue = parseFloat(formData.get("discountValue") as string || "0") || 0;
  const currencyCode = (formData.get("currencyCode") as string) || "USD";
  const productLevel = (formData.get("productLevel") as string) || "product";
  const combinesOrderDiscounts = formData.get("combinesOrderDiscounts") === "on";
  const combinesShippingDiscounts = formData.get("combinesShippingDiscounts") === "on";
  const layoutMode = (formData.get("layoutMode") as string) || "all_steps_one_page";

  if (!internalName || !publicTitle) {
    return { error: "Internal name and public title are required" };
  }

  const status = intent === "publish" ? "active" : "draft";

  let newOffer: { id: string } | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidateName = attempt === 0 ? internalName : `${internalName} (${attempt + 1})`;
    try {
      [newOffer] = await db
        .insert(offers)
        .values({
          shopId, type: "bundle", status,
          internalName: candidateName, publicTitle,
          description: description,
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

  // Combination policy
  await db.insert(offerCombinationPolicies).values({
    shopId, offerId: newOffer.id,
    combinesWithOrderDiscounts: combinesOrderDiscounts,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: combinesShippingDiscounts,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  });

  // Bundle definition
  const [bundleDef] = await db.insert(bundleDefinitions).values({
    shopId, offerId: newOffer.id,
    bundleType,
    title: publicTitle,
    description,
    layoutMode: bundleType === "bundle_page" ? layoutMode : "all_steps_one_page",
    createBundleProduct: false,
    config: { productLevel },
  }).returning({ id: bundleDefinitions.id });

  if (bundleDef) {
    if (bundleType === "classic") {
      // One step — products added later via detail page
      await db.insert(bundleSteps).values({
        shopId, bundleId: bundleDef.id,
        title: "Paso 1 — Seleccionar productos",
        sourceType: "products",
        sourceConfig: { productGids: [] },
        minQuantity: 1,
        maxQuantity: null,
        searchEnabled: false,
        sortOptions: [],
        filterOptions: [],
        sortOrder: 0,
      });
    } else if (bundleType === "mix_match") {
      // One step per mix item
      const mixItemCount = parseInt(formData.get("mix_item_count") as string || "0", 10);
      for (let i = 0; i < mixItemCount; i++) {
        const rawProducts = formData.get(`mix_products_${i}`) as string;
        let productGids: string[] = [];
        try { productGids = JSON.parse(rawProducts) as string[]; } catch { /* noop */ }
        const minQty = parseInt(formData.get(`mix_min_qty_${i}`) as string || "1", 10) || 1;

        await db.insert(bundleSteps).values({
          shopId, bundleId: bundleDef.id,
          title: `Artículo mixto ${i + 1}`,
          sourceType: "products",
          sourceConfig: { productGids },
          minQuantity: minQty,
          maxQuantity: null,
          searchEnabled: false,
          sortOptions: [],
          filterOptions: [],
          sortOrder: i,
        });
      }

      // Ensure at least one placeholder step if none submitted
      if (mixItemCount === 0) {
        await db.insert(bundleSteps).values({
          shopId, bundleId: bundleDef.id,
          title: "Artículo mixto 1",
          sourceType: "products",
          sourceConfig: { productGids: [] },
          minQuantity: 1,
          maxQuantity: null,
          searchEnabled: false,
          sortOptions: [],
          filterOptions: [],
          sortOrder: 0,
        });
      }
    } else if (bundleType === "bundle_page") {
      // Placeholder step — steps added on detail page
      await db.insert(bundleSteps).values({
        shopId, bundleId: bundleDef.id,
        title: "Paso 1",
        sourceType: "products",
        sourceConfig: { productGids: [] },
        minQuantity: 1,
        maxQuantity: null,
        searchEnabled: false,
        sortOptions: [],
        filterOptions: [],
        sortOrder: 0,
      });
    }

    // Tiers
    const tierQtys = formData.getAll("tier_qty[]") as string[];
    const tierLabels = formData.getAll("tier_label[]") as string[];
    const tierDiscountTypes = formData.getAll("tier_discount_type[]") as string[];
    const tierDiscountValues = formData.getAll("tier_discount_value[]") as string[];

    for (let i = 0; i < tierQtys.length; i++) {
      const qty = parseInt(tierQtys[i] ?? "0", 10);
      if (qty > 0) {
        await db.insert(bundleTiers).values({
          shopId, bundleId: bundleDef.id,
          minQuantity: qty,
          label: tierLabels[i] ?? "",
          discountType: (tierDiscountTypes[i] ?? discountType) as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
          value: { amount: parseFloat(tierDiscountValues[i] ?? "0"), currencyCode },
          sortOrder: i,
        });
      }
    }
  }

  return redirect(`/app/offers/${newOffer.id}`);
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function NewBundleOfferPage() {
  const navigate = useNavigate();
  const { template: templateSlug = "classic-bundle" } = useParams<{ template: string }>();

  const bundleTypeFromSlug = (SLUG_TO_TEMPLATE[templateSlug] ?? "classic") as "classic" | "mix_match" | "bundle_page";

  // Offer info
  const [internalName, setInternalName] = useState("");
  const [publicTitle, setPublicTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt] = useState("");

  // Discount
  const [discountType, setDiscountType] = useState("percentage");
  const [discountValue, setDiscountValue] = useState("0");

  // Classic
  const [productLevel, setProductLevel] = useState<"product" | "variant">("product");
  const [conditionProductsForClassic, setConditionProductsForClassic] = useState<string[]>([]);
  const [classicPickerOpen, setClassicPickerOpen] = useState(false);

  // Mix & match
  const [mixItems, setMixItems] = useState<{ products: string[]; minQty: string; useMinQty: boolean }[]>([
    { products: [], minQty: "1", useMinQty: false },
  ]);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [productPickerForItem, setProductPickerForItem] = useState<number | null>(null);

  // Bundle page
  const [layoutMode, setLayoutMode] = useState<"all_steps_one_page" | "one_step_per_page">("all_steps_one_page");

  // Tiers (for mix & match)
  const [tiers, setTiers] = useState<{ qty: string; label: string; discountType: string; value: string }[]>([]);

  // Combination policy
  const [combinesOrderDiscounts, setCombinesOrderDiscounts] = useState(true);
  const [combinesShippingDiscounts, setCombinesShippingDiscounts] = useState(true);

  // Page title per bundle type
  const pageTitles: Record<string, string> = {
    classic: "Crear paquete clásico",
    mix_match: "Crear Mix & Match",
    bundle_page: "Crear página de paquete",
  };
  const pageTitle = pageTitles[bundleTypeFromSlug] ?? "Crear paquete";

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

      <Form method="POST">
        {/* Hidden fields */}
        <input type="hidden" name="bundleType" value={bundleTypeFromSlug} />
        {bundleTypeFromSlug === "mix_match" && (
          <>
            <input type="hidden" name="mix_item_count" value={mixItems.length} />
            {mixItems.map((item, i) => (
              <span key={i}>
                <input type="hidden" name={`mix_products_${i}`} value={JSON.stringify(item.products)} />
                <input type="hidden" name={`mix_min_qty_${i}`} value={item.minQty} />
              </span>
            ))}
          </>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20, alignItems: "start" }}>

          {/* ── Left column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ══ CLASSIC BUNDLE ═══════════════════════════════════════════════ */}
            {bundleTypeFromSlug === "classic" && (
              <>
                {/* Información del paquete */}
                <div className="b-card">
                  <div className="b-card-header">Información del paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Nombre del paquete</label>
                      <input id="internalName" className="b-input" name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Solo para uso interno" />
                      <div className="b-help">Sólo para uso interno</div>
                    </div>

                    {/* Visualización en widget */}
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Título del paquete</label>
                          <input id="publicTitle" className="b-input" name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" placeholder="e.g. Paquete ahorro" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Descripción del paquete <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(opcional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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
                        <label className="b-label" htmlFor="endsAt">Hora de finalización</label>
                        <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                          value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Seleccionar paquete */}
                <div className="b-card">
                  <div className="b-card-header">Seleccionar paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label">Nivel de artículo del paquete</label>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="radio" name="productLevel" value="product"
                            checked={productLevel === "product"}
                            onChange={() => setProductLevel("product")}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                          <div>
                            <div className="b-checkbox-label">Nivel de producto</div>
                            <div className="b-checkbox-help">Cada producto cuenta como un artículo del paquete</div>
                          </div>
                        </label>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="radio" name="productLevel" value="variant"
                            checked={productLevel === "variant"}
                            onChange={() => setProductLevel("variant")}
                            style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                          <div>
                            <div className="b-checkbox-label">Nivel de variante</div>
                            <div className="b-checkbox-help">Cada variante cuenta como un artículo de paquete</div>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setClassicPickerOpen(true)}>
                        Seleccionar productos
                      </button>
                      <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                        {conditionProductsForClassic.length} productos seleccionados
                      </span>
                    </div>
                  </div>
                </div>

                {/* Descuento por paquete */}
                <div className="b-card">
                  <div className="b-card-header">Descuento por paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label className="b-label">Tipo</label>
                        <select className="b-select" name="discountType" value={discountType}
                          onChange={(e) => setDiscountType(e.target.value)}>
                          <option value="percentage">Porcentaje</option>
                          <option value="fixed_amount">Monto fijo</option>
                          <option value="fixed_price">Precio fijo</option>
                        </select>
                      </div>
                      <div>
                        <label className="b-label">Cantidad</label>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                            {discountType === "percentage" ? "%" : "$"}
                          </span>
                          <input className="b-input" type="number" name="discountValue"
                            value={discountValue} onChange={(e) => setDiscountValue(e.target.value)}
                            min="0" autoComplete="off" />
                        </div>
                      </div>
                    </div>
                    <div>
                      <span className="b-help" style={{ color: "var(--blue)", cursor: "pointer" }}>
                        Agregar: Descuento de envío
                      </span>
                    </div>
                  </div>
                </div>

                {/* Producto para el paquete */}
                <div className="b-card">
                  <div className="b-card-header">Producto para el paquete</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="createBundleProduct" />
                      <div>
                        <div className="b-checkbox-label">Crear un producto para este paquete</div>
                        <div className="b-checkbox-help">Esta característica creará un producto con su propia página de productos.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Código de descuento */}
                <div className="b-card">
                  <div className="b-card-header">Código de descuento</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Agregue un código de descuento personalizado</div>
                        <div className="b-checkbox-help">Si no se controla, Bogos aplicará su código de descuento predeterminado automáticamente.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Combinaciones */}
                <div className="b-card">
                  <div className="b-card-header">Esta oferta se puede combinar con</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesOrderDiscounts"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Descuentos de pedido</span>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesShippingDiscounts"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Descuentos de envío</span>
                    </label>
                  </div>
                </div>
              </>
            )}

            {/* ══ MIX & MATCH ══════════════════════════════════════════════════ */}
            {bundleTypeFromSlug === "mix_match" && (
              <>
                {/* Información del paquete */}
                <div className="b-card">
                  <div className="b-card-header">Información del paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Nombre del paquete</label>
                      <input id="internalName" className="b-input" name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Solo para uso interno" />
                      <div className="b-help">Sólo para uso interno</div>
                    </div>
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Título del paquete</label>
                          <input id="publicTitle" className="b-input" name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Descripción del paquete <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(opcional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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
                        <label className="b-label" htmlFor="endsAt">Hora de finalización</label>
                        <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                          value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Seleccionar elementos mixtos */}
                <div className="b-card">
                  <div className="b-card-header">Seleccionar elementos mixtos</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="radio" name="mixMode" value="one_list"
                          style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                        <span className="b-checkbox-label">Mezclar artículos de una lista de productos</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="radio" name="mixMode" value="per_item" defaultChecked
                          style={{ accentColor: "var(--blue)", width: 15, height: 15 }} />
                        <span className="b-checkbox-label">Cada artículo Mix contiene una lista diferente de productos.</span>
                      </label>
                    </div>

                    {mixItems.map((item, i) => (
                      <div key={i} className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                        <div className="b-card-header" style={{ fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Artículo mixto {i + 1}</span>
                          {mixItems.length > 1 && (
                            <button type="button"
                              style={{ background: "none", border: "none", cursor: "pointer", color: "#ff4d4d", fontSize: 16, lineHeight: 1 }}
                              onClick={() => setMixItems(mixItems.filter((_, idx) => idx !== i))}>
                              ×
                            </button>
                          )}
                        </div>
                        <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div>
                            <label className="b-label">Seleccione una lista de productos:</label>
                            <select className="b-select" defaultValue="">
                              <option value="">productos seleccionados</option>
                            </select>
                          </div>
                          <div>
                            <div className="b-label" style={{ marginBottom: 6 }}>Productos:</div>
                            <button type="button" className="b-btn b-btn-secondary"
                              onClick={() => {
                                setProductPickerForItem(i);
                                setProductPickerOpen(true);
                              }}>
                              Seleccionar productos
                            </button>
                            <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                              {item.products.length} productos seleccionados
                            </span>
                          </div>
                          <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                            <input type="checkbox"
                              checked={item.useMinQty}
                              onChange={(e) => {
                                const next = [...mixItems];
                                next[i] = { ...next[i]!, useMinQty: e.target.checked };
                                setMixItems(next);
                              }} />
                            <span className="b-checkbox-label">Establecer la cantidad mínima</span>
                          </label>
                          {item.useMinQty && (
                            <div>
                              <label className="b-label">Cantidad mínima</label>
                              <input className="b-input" type="number" min="1"
                                value={item.minQty}
                                onChange={(e) => {
                                  const next = [...mixItems];
                                  next[i] = { ...next[i]!, minQty: e.target.value };
                                  setMixItems(next);
                                }}
                                style={{ maxWidth: 100 }} autoComplete="off" />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    <div>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setMixItems([...mixItems, { products: [], minQty: "1", useMinQty: false }])}>
                        + Añadir elemento Mix
                      </button>
                    </div>
                  </div>
                </div>

                {/* Descuento (tiers) */}
                <div className="b-card">
                  <div className="b-card-header">Descuento</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* Hidden fallback discount fields */}
                    <input type="hidden" name="discountType" value={discountType} />
                    <input type="hidden" name="discountValue" value={discountValue} />

                    {tiers.map((tier, i) => (
                      <div key={i} className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                        <div className="b-card-header" style={{ fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Nivel {i + 1}</span>
                          <button type="button"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#ff4d4d", fontSize: 16, lineHeight: 1 }}
                            onClick={() => setTiers(tiers.filter((_, idx) => idx !== i))}>
                            ×
                          </button>
                        </div>
                        <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                              <label className="b-label">Cantidad</label>
                              <input className="b-input" type="number" name="tier_qty[]"
                                value={tier.qty}
                                onChange={(e) => {
                                  const t = [...tiers];
                                  t[i] = { ...t[i]!, qty: e.target.value };
                                  setTiers(t);
                                }}
                                min="1" autoComplete="off" />
                            </div>
                            <div>
                              <label className="b-label">Texto de la etiqueta</label>
                              <input className="b-input" type="text" name="tier_label[]"
                                value={tier.label}
                                onChange={(e) => {
                                  const t = [...tiers];
                                  t[i] = { ...t[i]!, label: e.target.value };
                                  setTiers(t);
                                }}
                                autoComplete="off" />
                            </div>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                              <label className="b-label">Tipo</label>
                              <select className="b-select" name="tier_discount_type[]"
                                value={tier.discountType}
                                onChange={(e) => {
                                  const t = [...tiers];
                                  t[i] = { ...t[i]!, discountType: e.target.value };
                                  setTiers(t);
                                }}>
                                <option value="percentage">Porcentaje</option>
                                <option value="fixed_amount">Monto fijo</option>
                                <option value="fixed_price">Precio fijo</option>
                              </select>
                            </div>
                            <div>
                              <label className="b-label">Valor</label>
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <span style={{ fontSize: 13, color: "var(--text-sub)" }}>
                                  {tier.discountType === "percentage" ? "%" : "$"}
                                </span>
                                <input className="b-input" type="number" name="tier_discount_value[]"
                                  value={tier.value}
                                  onChange={(e) => {
                                    const t = [...tiers];
                                    t[i] = { ...t[i]!, value: e.target.value };
                                    setTiers(t);
                                  }}
                                  min="0" autoComplete="off" />
                              </div>
                            </div>
                          </div>
                          <div>
                            <span className="b-help" style={{ color: "var(--blue)", cursor: "pointer" }}>
                              Agregar: Descuento de envío
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}

                    <div>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setTiers([...tiers, { qty: "", label: "", discountType: "percentage", value: "" }])}>
                        + Agregar nivel
                      </button>
                    </div>
                  </div>
                </div>

                {/* Código de descuento */}
                <div className="b-card">
                  <div className="b-card-header">Código de descuento</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Agregue un código de descuento personalizado</div>
                        <div className="b-checkbox-help">Si no se controla, Bogos aplicará su código de descuento predeterminado automáticamente.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Combinaciones */}
                <div className="b-card">
                  <div className="b-card-header">Esta oferta se puede combinar con</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesOrderDiscounts"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Descuentos de pedido</span>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesShippingDiscounts"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Descuentos de envío</span>
                    </label>
                  </div>
                </div>
              </>
            )}

            {/* ══ BUNDLE PAGE ══════════════════════════════════════════════════ */}
            {bundleTypeFromSlug === "bundle_page" && (
              <>
                {/* Hidden discount fields (bundle page adds discounts on detail page) */}
                <input type="hidden" name="discountType" value="percentage" />
                <input type="hidden" name="discountValue" value="0" />

                {/* Información del paquete */}
                <div className="b-card">
                  <div className="b-card-header">Información del paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Nombre del paquete</label>
                      <input id="internalName" className="b-input" name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Solo para uso interno" />
                    </div>
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Visualización en widget</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Encabezado de página</label>
                          <input id="publicTitle" className="b-input" name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Subtítulo de página <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(opcional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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
                        <label className="b-label" htmlFor="endsAt">Hora de finalización</label>
                        <input id="endsAt" className="b-input" type="datetime-local" name="endsAt"
                          value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Layout selector */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label
                    style={{
                      border: `2px solid ${layoutMode === "one_step_per_page" ? "var(--blue)" : "var(--border)"}`,
                      borderRadius: "var(--r)",
                      padding: 16,
                      cursor: "pointer",
                      background: layoutMode === "one_step_per_page" ? "var(--blue-light, #eef2ff)" : "var(--bg-card)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <input type="radio" name="layoutMode" value="one_step_per_page"
                      checked={layoutMode === "one_step_per_page"}
                      onChange={() => setLayoutMode("one_step_per_page")}
                      style={{ display: "none" }} />
                    {/* Diagram: single column */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 60 }}>
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Un paso por página</span>
                  </label>

                  <label
                    style={{
                      border: `2px solid ${layoutMode === "all_steps_one_page" ? "var(--blue)" : "var(--border)"}`,
                      borderRadius: "var(--r)",
                      padding: 16,
                      cursor: "pointer",
                      background: layoutMode === "all_steps_one_page" ? "var(--blue-light, #eef2ff)" : "var(--bg-card)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <input type="radio" name="layoutMode" value="all_steps_one_page"
                      checked={layoutMode === "all_steps_one_page"}
                      onChange={() => setLayoutMode("all_steps_one_page")}
                      style={{ display: "none" }} />
                    {/* Diagram: two columns */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, width: 60 }}>
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                      <div style={{ height: 8, background: "var(--border)", borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Múltiples pasos en una página</span>
                  </label>
                </div>

                {/* Imagen del banner */}
                <div className="b-card">
                  <div className="b-card-header">Imagen del banner</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{
                      border: "2px dashed var(--border)", borderRadius: "var(--r)",
                      padding: "32px 16px", textAlign: "center",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                    }}>
                      <button type="button" className="b-btn b-btn-secondary">Agregar archivo</button>
                    </div>
                    <div className="b-help">
                      Especificaciones de imagen recomendadas: Dimensiones 1200x240 píxeles, menos de 1 MB y los formatos admitidos son gif, jpg y png.
                    </div>
                    <div>
                      <span style={{ fontSize: 13, color: "var(--blue)", cursor: "pointer" }}>Banner transparente</span>
                    </div>
                  </div>
                </div>

                {/* Estructura del paquete */}
                <div className="b-card">
                  <div className="b-card-header">Estructura del paquete</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div className="b-help">
                      Cada paso contiene un conjunto diferente de productos. Los clientes seleccionarán productos de cada paso para completar el paquete.
                    </div>
                    <div>
                      <button type="button" className="b-btn b-btn-secondary">
                        + Añadir paso
                      </button>
                    </div>
                  </div>
                </div>

                {/* Descuento por paquete */}
                <div className="b-card">
                  <div className="b-card-header">Descuento por paquete</div>
                  <div className="b-card-body">
                    <button type="button" className="b-btn b-btn-secondary">
                      + Añadir descuento
                    </button>
                  </div>
                </div>

                {/* Configuración avanzada */}
                <details className="b-card">
                  <summary className="b-card-header" style={{ cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Configuración avanzada (opcional)</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </summary>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Agregue un código de descuento personalizado</div>
                        <div className="b-checkbox-help">Si no se controla, Bogos aplicará su código de descuento predeterminado automáticamente.</div>
                      </div>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                      <div className="b-label" style={{ marginBottom: 4 }}>Esta oferta se puede combinar con</div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="combinesOrderDiscounts"
                          checked={combinesOrderDiscounts}
                          onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                        <span className="b-checkbox-label">Descuentos de pedido</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="combinesShippingDiscounts"
                          checked={combinesShippingDiscounts}
                          onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                        <span className="b-checkbox-label">Descuentos de envío</span>
                      </label>
                    </div>
                  </div>
                </details>
              </>
            )}

          </div>

          {/* ── Right column: Preview / Summary ── */}
          <div style={{ position: "sticky", top: 16 }}>
            {bundleTypeFromSlug === "classic" && (
              <div className="b-card">
                <div className="b-card-header">Avance</div>
                <div className="b-card-body">
                  <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                    There are no product selected. Select at least 2 bundle items to preview this widget.
                  </div>
                </div>
              </div>
            )}

            {bundleTypeFromSlug === "mix_match" && (
              <div className="b-card">
                <div className="b-card-header">Avance</div>
                <div className="b-card-body">
                  <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                    Configure los artículos mix y el descuento para ver el avance del widget.
                  </div>
                </div>
              </div>
            )}

            {bundleTypeFromSlug === "bundle_page" && (
              <div className="b-card">
                <div className="b-card-header">Resumen de la página del paquete</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
                    <strong style={{ color: "var(--text)" }}>0 pasos</strong> configurados
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Discount(s)</div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Sin descuentos añadidos</div>
                  </div>
                  <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Cómo mostrar el paquete</div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>Los clientes seleccionan productos de cada paso</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>El descuento se aplica al completar el paquete</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>Configurable por pasos y cantidades</span>
                      </div>
                    </div>
                  </div>
                  <button type="button" className="b-btn b-btn-secondary"
                    disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                    Vista previa del paquete
                  </button>
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

      {/* Product pickers */}
      <ProductPicker
        open={classicPickerOpen}
        onClose={() => setClassicPickerOpen(false)}
        title="Seleccionar productos para el paquete"
        mode="products"
        allowMultiple
        selectedIds={conditionProductsForClassic}
        onSelect={(gids) => setConditionProductsForClassic(gids)}
      />

      <ProductPicker
        open={productPickerOpen}
        onClose={() => {
          setProductPickerOpen(false);
          setProductPickerForItem(null);
        }}
        title={`Seleccionar productos — Artículo mixto ${productPickerForItem !== null ? productPickerForItem + 1 : ""}`}
        mode="products"
        allowMultiple
        selectedIds={productPickerForItem !== null ? (mixItems[productPickerForItem]?.products ?? []) : []}
        onSelect={(gids) => {
          if (productPickerForItem !== null) {
            const next = [...mixItems];
            next[productPickerForItem] = { ...next[productPickerForItem]!, products: gids };
            setMixItems(next);
          }
        }}
      />

    </div>
  );
}
