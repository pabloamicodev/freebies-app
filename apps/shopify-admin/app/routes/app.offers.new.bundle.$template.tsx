/**
 * Bundle Offer Creation Wizard — dynamic route per template slug
 * Routes: /app/offers/new/bundle/classic-bundle → Classic Bundle wizard
 *         /app/offers/new/bundle/mix-match      → Mix & Match wizard
 *         /app/offers/new/bundle/bundle-page    → Bundle Page wizard
 */

import { Form, useNavigate, redirect, useParams } from "react-router";
import { useState } from "react";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import {
  offers, offerCombinationPolicies,
  bundleDefinitions, bundleSteps, bundleTiers,
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
  const { shopId, db } = await getShopContext(request);
  const formData = await request.formData();
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
          title: `Mix item ${i + 1}`,
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
          title: "Mix item 1",
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

  // Validation
  const [fieldErrors, setFieldErrors] = useState<{ internalName?: string; publicTitle?: string }>({});
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  function validate() {
    const errs: { internalName?: string; publicTitle?: string } = {};
    if (!internalName.trim()) errs.internalName = "Bundle name is required";
    if (!publicTitle.trim()) errs.publicTitle = "Bundle title is required";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

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
    classic: "Create classic bundle",
    mix_match: "Create Mix & Match",
    bundle_page: "Create bundle page",
  };
  const pageTitle = pageTitles[bundleTypeFromSlug] ?? "Create bundle";

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
          <div style={{ width: 44, height: 44, borderRadius: 14, background: "var(--bundle-grad)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 4px 14px rgba(13,148,136,0.28)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="12" y1="12" x2="12" y2="17"/><line x1="9.5" y1="14.5" x2="14.5" y2="14.5"/></svg>
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>{pageTitle}</h1>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Configure your bundle offer</div>
          </div>
          <span style={{ marginLeft: "auto", background: "rgba(13,148,136,0.1)", color: "var(--bundle-color)", border: "1.5px solid rgba(13,148,136,0.2)", borderRadius: 20, fontSize: 11, fontWeight: 700, padding: "4px 12px", letterSpacing: "0.2px" }}>Bundle</span>
        </div>
      </div>

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
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
                {/* Bundle information */}
                <div className="b-card" style={{ borderTop: "3px solid var(--bundle-color)" }}>
                  <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--bundle-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>1</div>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Bundle information</span>
                    <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(13,148,136,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>1</span>
                  </div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Bundle name</label>
                      <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Internal use only" />
                      <div className="b-help">Internal use only</div>
                    </div>

                    {/* Widget display */}
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Bundle title</label>
                          <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" placeholder="e.g. Savings bundle" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Bundle description <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(optional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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

                {/* Seleccionar paquete */}
                <div className="b-card" style={{ borderTop: "3px solid var(--bundle-color)" }}>
                  <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--bundle-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>2</div>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Bundle products</span>
                    <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(13,148,136,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>2</span>
                  </div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label">Bundle item level</label>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="radio" name="productLevel" value="product"
                            checked={productLevel === "product"}
                            onChange={() => setProductLevel("product")}
                            style={{ accentColor: "var(--bundle-color)", width: 15, height: 15 }} />
                          <div>
                            <div className="b-checkbox-label">Product level</div>
                            <div className="b-checkbox-help">Each product counts as a bundle item</div>
                          </div>
                        </label>
                        <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                          <input type="radio" name="productLevel" value="variant"
                            checked={productLevel === "variant"}
                            onChange={() => setProductLevel("variant")}
                            style={{ accentColor: "var(--bundle-color)", width: 15, height: 15 }} />
                          <div>
                            <div className="b-checkbox-label">Variant level</div>
                            <div className="b-checkbox-help">Each variant counts as a bundle item</div>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setClassicPickerOpen(true)}>
                        Select products
                      </button>
                      <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                        {conditionProductsForClassic.length} products selected
                      </span>
                    </div>
                  </div>
                </div>

                {/* Bundle discount */}
                <div className="b-card" style={{ borderTop: "3px solid var(--bundle-color)" }}>
                  <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", overflow: "hidden" }}>
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--bundle-color)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>3</div>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>Bundle discount</span>
                    <span style={{ position: "absolute", right: 14, fontSize: 48, fontWeight: 800, fontFamily: "var(--font-display)", color: "rgba(13,148,136,0.06)", lineHeight: 1, userSelect: "none", pointerEvents: "none", top: "50%", transform: "translateY(-50%)" }}>3</span>
                  </div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label className="b-label">Type</label>
                        <select className="b-select" name="discountType" value={discountType}
                          onChange={(e) => setDiscountType(e.target.value)}>
                          <option value="percentage">Percentage</option>
                          <option value="fixed_amount">Fixed amount</option>
                          <option value="fixed_price">Fixed price</option>
                        </select>
                      </div>
                      <div>
                        <label className="b-label">Amount</label>
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
                      <span className="b-help" style={{ color: "var(--bundle-color)", cursor: "pointer" }}>
                        Add: Shipping discount
                      </span>
                    </div>
                  </div>
                </div>

                {/* Producto para el paquete */}
                <div className="b-card">
                  <div className="b-card-header">Bundle product</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="createBundleProduct" />
                      <div>
                        <div className="b-checkbox-label">Create a product for this bundle</div>
                        <div className="b-checkbox-help">This feature will create a product with its own product page.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Discount code */}
                <div className="b-card">
                  <div className="b-card-header">Discount code</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Add a custom discount code</div>
                        <div className="b-checkbox-help">If unchecked, Bogos will apply its default discount code automatically.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Combinaciones */}
                <div className="b-card">
                  <div className="b-card-header">This offer can be combined with</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesOrderDiscounts"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Order discounts</span>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesShippingDiscounts"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Shipping discounts</span>
                    </label>
                  </div>
                </div>
              </>
            )}

            {/* ══ MIX & MATCH ══════════════════════════════════════════════════ */}
            {bundleTypeFromSlug === "mix_match" && (
              <>
                {/* Bundle information */}
                <div className="b-card">
                  <div className="b-card-header">Bundle information</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Bundle name</label>
                      <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Internal use only" />
                      <div className="b-help">Internal use only</div>
                    </div>
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Bundle title</label>
                          <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Bundle description <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(optional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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

                {/* Seleccionar elementos mixtos */}
                <div className="b-card">
                  <div className="b-card-header">Mix items</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="radio" name="mixMode" value="one_list"
                          style={{ accentColor: "var(--bundle-color)", width: 15, height: 15 }} />
                        <span className="b-checkbox-label">Mix items from a product list</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="radio" name="mixMode" value="per_item" defaultChecked
                          style={{ accentColor: "var(--bundle-color)", width: 15, height: 15 }} />
                        <span className="b-checkbox-label">Each Mix item contains a different product list.</span>
                      </label>
                    </div>

                    {mixItems.map((item, i) => (
                      <div key={i} className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                        <div className="b-card-header" style={{ fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Mix item {i + 1}</span>
                          {mixItems.length > 1 && (
                            <button type="button"
                              className="b-modal-close" style={{ width: 22, height: 22 }}
                              onClick={() => setMixItems(mixItems.filter((_, idx) => idx !== i))}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          )}
                        </div>
                        <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div>
                            <label className="b-label">Select a product list:</label>
                            <select className="b-select" defaultValue="">
                              <option value="">selected products</option>
                            </select>
                          </div>
                          <div>
                            <div className="b-label" style={{ marginBottom: 6 }}>Products:</div>
                            <button type="button" className="b-btn b-btn-secondary"
                              onClick={() => {
                                setProductPickerForItem(i);
                                setProductPickerOpen(true);
                              }}>
                              Select products
                            </button>
                            <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-sub)" }}>
                              {item.products.length} products selected
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
                            <span className="b-checkbox-label">Set minimum quantity</span>
                          </label>
                          {item.useMinQty && (
                            <div>
                              <label className="b-label">Minimum quantity</label>
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
                        + Add Mix item
                      </button>
                    </div>
                  </div>
                </div>

                {/* Descuento (tiers) */}
                <div className="b-card">
                  <div className="b-card-header">Discount</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* Hidden fallback discount fields */}
                    <input type="hidden" name="discountType" value={discountType} />
                    <input type="hidden" name="discountValue" value={discountValue} />

                    {tiers.map((tier, i) => (
                      <div key={i} className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                        <div className="b-card-header" style={{ fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>Tier {i + 1}</span>
                          <button type="button"
                            className="b-modal-close" style={{ width: 22, height: 22 }}
                            onClick={() => setTiers(tiers.filter((_, idx) => idx !== i))}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                        <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                              <label className="b-label">Quantity</label>
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
                              <label className="b-label">Label text</label>
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
                              <label className="b-label">Type</label>
                              <select className="b-select" name="tier_discount_type[]"
                                value={tier.discountType}
                                onChange={(e) => {
                                  const t = [...tiers];
                                  t[i] = { ...t[i]!, discountType: e.target.value };
                                  setTiers(t);
                                }}>
                                <option value="percentage">Percentage</option>
                                <option value="fixed_amount">Fixed amount</option>
                                <option value="fixed_price">Fixed price</option>
                              </select>
                            </div>
                            <div>
                              <label className="b-label">Value</label>
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
                            <span className="b-help" style={{ color: "var(--bundle-color)", cursor: "pointer" }}>
                              Add: Shipping discount
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}

                    <div>
                      <button type="button" className="b-btn b-btn-secondary"
                        onClick={() => setTiers([...tiers, { qty: "", label: "", discountType: "percentage", value: "" }])}>
                        + Add tier
                      </button>
                    </div>
                  </div>
                </div>

                {/* Discount code */}
                <div className="b-card">
                  <div className="b-card-header">Discount code</div>
                  <div className="b-card-body">
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Add a custom discount code</div>
                        <div className="b-checkbox-help">If unchecked, Bogos will apply its default discount code automatically.</div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Combinaciones */}
                <div className="b-card">
                  <div className="b-card-header">This offer can be combined with</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesOrderDiscounts"
                        checked={combinesOrderDiscounts}
                        onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Order discounts</span>
                    </label>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="combinesShippingDiscounts"
                        checked={combinesShippingDiscounts}
                        onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                      <span className="b-checkbox-label">Shipping discounts</span>
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

                {/* Bundle information */}
                <div className="b-card">
                  <div className="b-card-header">Bundle information</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label className="b-label" htmlFor="internalName">Bundle name</label>
                      <input id="internalName" className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`} name="internalName"
                        value={internalName} onChange={(e) => setInternalName(e.target.value)}
                        autoComplete="off" placeholder="Internal use only" />
                    </div>
                    <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                      <div className="b-card-header" style={{ fontSize: 13 }}>Widget display</div>
                      <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <div>
                          <label className="b-label" htmlFor="publicTitle">Page header</label>
                          <input id="publicTitle" className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`} name="publicTitle"
                            value={publicTitle} onChange={(e) => setPublicTitle(e.target.value)}
                            autoComplete="off" />
                        </div>
                        <div>
                          <label className="b-label" htmlFor="description">Page subtitle <span style={{ fontWeight: 400, color: "var(--text-sub)" }}>(optional)</span></label>
                          <textarea id="description" className="b-input" name="description"
                            value={description} onChange={(e) => setDescription(e.target.value)}
                            autoComplete="off" rows={2} style={{ resize: "vertical" }} />
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

                {/* Layout selector */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label
                    style={{
                      border: `2px solid ${layoutMode === "one_step_per_page" ? "var(--bundle-color)" : "var(--border)"}`,
                      borderRadius: "var(--r)",
                      padding: 16,
                      cursor: "pointer",
                      background: layoutMode === "one_step_per_page" ? "rgba(13,148,136,0.06)" : "var(--bg-card)",
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
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>One step per page</span>
                  </label>

                  <label
                    style={{
                      border: `2px solid ${layoutMode === "all_steps_one_page" ? "var(--bundle-color)" : "var(--border)"}`,
                      borderRadius: "var(--r)",
                      padding: 16,
                      cursor: "pointer",
                      background: layoutMode === "all_steps_one_page" ? "rgba(13,148,136,0.06)" : "var(--bg-card)",
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
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>Multiple steps on one page</span>
                  </label>
                </div>

                {/* Imagen del banner */}
                <div className="b-card">
                  <div className="b-card-header">Banner image</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{
                      border: "2px dashed var(--border)", borderRadius: "var(--r)",
                      padding: "32px 16px", textAlign: "center",
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                    }}>
                      <button type="button" className="b-btn b-btn-secondary">Add file</button>
                    </div>
                    <div className="b-help">
                      Recommended image specs: 1200x240px, under 1 MB, supported formats: gif, jpg, png.
                    </div>
                    <div>
                      <span style={{ fontSize: 13, color: "var(--bundle-color)", cursor: "pointer" }}>Transparent banner</span>
                    </div>
                  </div>
                </div>

                {/* Estructura del paquete */}
                <div className="b-card">
                  <div className="b-card-header">Bundle structure</div>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div className="b-help">
                      Each step contains a different set of products. Customers select from each step to complete the bundle.
                    </div>
                    <div>
                      <button type="button" className="b-btn b-btn-secondary">
                        + Add step
                      </button>
                    </div>
                  </div>
                </div>

                {/* Bundle discount */}
                <div className="b-card">
                  <div className="b-card-header">Bundle discount</div>
                  <div className="b-card-body">
                    <button type="button" className="b-btn b-btn-secondary">
                      + Add discount
                    </button>
                  </div>
                </div>

                {/* Configuración avanzada */}
                <details className="b-card">
                  <summary className="b-card-header" style={{ cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Advanced settings (optional)</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </summary>
                  <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                      <input type="checkbox" name="customDiscountCode" />
                      <div>
                        <div className="b-checkbox-label">Add a custom discount code</div>
                        <div className="b-checkbox-help">If unchecked, Bogos will apply its default discount code automatically.</div>
                      </div>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                      <div className="b-label" style={{ marginBottom: 4 }}>This offer can be combined with</div>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="combinesOrderDiscounts"
                          checked={combinesOrderDiscounts}
                          onChange={(e) => setCombinesOrderDiscounts(e.target.checked)} />
                        <span className="b-checkbox-label">Order discounts</span>
                      </label>
                      <label className="b-checkbox-row" style={{ cursor: "pointer", gap: 10 }}>
                        <input type="checkbox" name="combinesShippingDiscounts"
                          checked={combinesShippingDiscounts}
                          onChange={(e) => setCombinesShippingDiscounts(e.target.checked)} />
                        <span className="b-checkbox-label">Shipping discounts</span>
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
                <div className="b-card-header">Preview</div>
                <div className="b-card-body">
                  <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                    There are no product selected. Select at least 2 bundle items to preview this widget.
                  </div>
                </div>
              </div>
            )}

            {bundleTypeFromSlug === "mix_match" && (
              <div className="b-card">
                <div className="b-card-header">Preview</div>
                <div className="b-card-body">
                  <div style={{ fontSize: 13, color: "var(--text-sub)", textAlign: "center", padding: "20px 0" }}>
                    Configure mix items and discount to preview the widget.
                  </div>
                </div>
              </div>
            )}

            {bundleTypeFromSlug === "bundle_page" && (
              <div className="b-card">
                <div className="b-card-header">Bundle page summary</div>
                <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ fontSize: 13, color: "var(--text-sub)" }}>
                    <strong style={{ color: "var(--text)" }}>0 steps</strong> configured
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Discount(s)</div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)" }}>No discounts added</div>
                  </div>
                  <div className="b-card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
                    <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>How the bundle displays</div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>Customers select products from each step</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>Discount applies on bundle completion</span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-sub)", display: "flex", gap: 6 }}>
                        <span>•</span><span>Configurable by steps and quantities</span>
                      </div>
                    </div>
                  </div>
                  <button type="button" className="b-btn b-btn-secondary"
                    disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                    Bundle preview
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* ── Footer ── */}
        <div style={{ position: "sticky", bottom: 0, zIndex: 10, display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, padding: "14px 0", background: "rgba(250,249,247,0.9)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderTop: "1px solid var(--border)" }}>
          <button type="button" className="b-btn b-btn-secondary"
            onClick={() => void navigate("/app/offers")}>
            Cancel
          </button>
          <button type="submit" name="intent" value="draft" className="b-btn b-btn-secondary">
            Save draft
          </button>
          <button type="submit" name="intent" value="publish" className="b-btn b-btn-primary" style={{ background: "var(--bundle-grad)", boxShadow: "0 4px 12px rgba(13,148,136,0.3)" }}>
            Publish offer
          </button>
        </div>

      </Form>

      {/* Product pickers */}
      <ProductPicker
        open={classicPickerOpen}
        onClose={() => setClassicPickerOpen(false)}
        title="Select bundle products"
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
        title={`Select products — Mix item ${productPickerForItem !== null ? productPickerForItem + 1 : ""}`}
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

      {showToast && (
        <Toast message={toastMsg} type="error" onDismiss={() => setShowToast(false)} />
      )}
    </div>
  );
}
