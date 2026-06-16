/**
 * Offer Conditions Editor — Step 2-3 of the offer builder wizard.
 * Allows adding/editing main conditions and subconditions with a
 * validated form for each condition type.
 */

import { useLoaderData, Form, Link, useActionData, useNavigation } from "react-router";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary.js";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions } from "@promo/db";
import { and, eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

function splitCsvList(value: string | null): string[] {
  return (value ?? "").split(",").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function splitCountryCsv(value: string | null): string[] {
  return (value ?? "").split(",").flatMap((item) => {
    const code = item.trim().toUpperCase();
    return code ? [code] : [];
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const conditionRows = await db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));

  return {
    offer,
    conditions: conditionRows.sort((a, b) => a.sortOrder - b.sortOrder),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  await loadOwnedOffer(db, shopId, offerId);

  if (intent === "add_condition") {
    const conditionType = formData.get("conditionType") as string;
    const scope = formData.get("scope") as "main" | "sub";

    // Build value object based on condition type
    let value: Record<string, unknown> = {};
    switch (conditionType) {
      case "cart_value": {
        const thresh = parseFloat(formData.get("threshold") as string);
        if (!Number.isFinite(thresh) || thresh < 0) return { error: "Threshold must be a valid positive number." };
        value = {
          thresholdCents: Math.round(thresh * 100),
          currencyCode: formData.get("currencyCode") ?? "USD",
          includeGiftValues: formData.get("includeGiftValues") === "on",
        };
        break;
      }
      case "cart_quantity": {
        const minQty = parseInt(formData.get("minQty") as string, 10);
        if (!Number.isFinite(minQty) || minQty < 1) return { error: "Minimum quantity must be at least 1." };
        const maxQtyRaw = formData.get("maxQty");
        const maxQty = maxQtyRaw ? parseInt(maxQtyRaw as string, 10) : undefined;
        value = {
          minQuantity: minQty,
          maxQuantity: maxQty !== undefined && Number.isFinite(maxQty) ? maxQty : undefined,
          includeGiftValues: false,
        };
        break;
      }
      case "cart_value_multiplier": {
        const multThresh = parseFloat(formData.get("threshold") as string);
        if (!Number.isFinite(multThresh) || multThresh < 0) return { error: "Threshold must be a valid positive number." };
        const multRaw = formData.get("maxMultiplier");
        const maxMult = multRaw ? parseInt(multRaw as string, 10) : undefined;
        value = {
          thresholdCents: Math.round(multThresh * 100),
          currencyCode: formData.get("currencyCode") ?? "USD",
          maxMultiplier: maxMult !== undefined && Number.isFinite(maxMult) ? maxMult : undefined,
          includeGiftValues: false,
        };
        break;
      }
      case "customer_tags":
        value = {
          includeTags: splitCsvList(formData.get("includeTags") as string | null),
          excludeTags: splitCsvList(formData.get("excludeTags") as string | null),
          treatGuestAsNoTags: formData.get("treatGuestAsNoTags") === "on",
        };
        break;
      case "order_history_total_spent": {
        const orderVal = parseFloat(formData.get("orderValue") as string);
        if (!Number.isFinite(orderVal) || orderVal < 0) return { error: "Order value must be a valid positive number." };
        value = {
          type: "total_spent",
          operator: formData.get("operator") as string,
          valueCents: Math.round(orderVal * 100),
        };
        break;
      }
      case "one_use_per_customer":
        value = {};
        break;
      case "markets":
        value = {
          includeMarketIds: splitCsvList(formData.get("includeMarkets") as string | null),
          excludeMarketIds: splitCsvList(formData.get("excludeMarkets") as string | null),
        };
        break;
      case "customer_location":
        value = {
          includeCountryCodes: splitCountryCsv(formData.get("includeCountries") as string | null),
          excludeCountryCodes: splitCountryCsv(formData.get("excludeCountries") as string | null),
        };
        break;
      case "sales_channels":
        value = { channels: formData.getAll("channels[]") as string[] };
        break;
      case "specific_product":
      case "pack_of_products": {
        const gidsRaw = (formData.get("requiredVariantGids") as string | null) ?? "";
        const variantIds = splitCsvList(gidsRaw);
        if (variantIds.length === 0) {
          // Return early with validation error rather than inserting an empty condition
          return { error: "Select at least one product before adding this condition." };
        }
        value = {
          variantIds,
          minQtyPerProduct: parseInt((formData.get("minQtyPerProduct") as string | null) ?? "1", 10) || 1,
          multiplyGifts: false,
          giftsMatchProducts: false,
          trackMode: "product",
          appliesTo: "specific_products",
        };
        break;
      }
    }

    const existingCount = await db.select({ id: offerConditions.id })
      .from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));

    await db.insert(offerConditions).values({
      shopId, offerId,
      scope,
      conditionType,
      operator: "gte",
      value,
      sortOrder: existingCount.length,
      isEnabled: true,
    });
  }

  if (intent === "delete_condition") {
    const conditionId = formData.get("conditionId") as string;
    await db.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)));
  }

  return { success: true };
};

const MAIN_CONDITION_TYPES = [
  { label: "Cart Value — spend threshold", value: "cart_value" },
  { label: "Cart Quantity — item count threshold", value: "cart_quantity" },
  { label: "Cart Value Multiplier — earn gifts per $ spent", value: "cart_value_multiplier" },
  { label: "Specific Product — must contain selected products", value: "specific_product" },
  { label: "Pack of Products — all products must be present", value: "pack_of_products" },
];

const SUB_CONDITION_TYPES = [
  { label: "Customer Tags", value: "customer_tags" },
  { label: "Order History — total spent", value: "order_history_total_spent" },
  { label: "Order History — total orders", value: "order_history_total_orders" },
  { label: "One Use Per Customer", value: "one_use_per_customer" },
  { label: "Shopify Markets", value: "markets" },
  { label: "Country / IP location", value: "customer_location" },
  { label: "Sales Channel", value: "sales_channels" },
  { label: "Subscription Products Only", value: "subscription_product_type" },
  { label: "Specific Link / Magic URL", value: "specific_link" },
];

export default function OfferConditionsPage() {
  const { offer, conditions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const [conditionState, setConditionField] = useObjectState({
    addingScope: null as "main" | "sub" | null,
    selectedType: "",
    pickerOpen: false,
    pickerTarget: "required" as "required" | "exclude" | "gift",
    requiredVariantGids: [] as string[],
    excludeVariantGids: [] as string[],
    currencyCode: "USD",
    minQtyPerProduct: "1",
  });
  const {
    addingScope,
    selectedType,
    pickerOpen,
    pickerTarget,
    requiredVariantGids,
    excludeVariantGids,
    currencyCode,
    minQtyPerProduct,
  } = conditionState;
  const setAddingScope = createFieldSetter(setConditionField, "addingScope");
  const setSelectedType = createFieldSetter(setConditionField, "selectedType");
  const setPickerOpen = createFieldSetter(setConditionField, "pickerOpen");
  const setPickerTarget = createFieldSetter(setConditionField, "pickerTarget");
  const setRequiredVariantGids = createFieldSetter(setConditionField, "requiredVariantGids");
  const setExcludeVariantGids = createFieldSetter(setConditionField, "excludeVariantGids");
  const setCurrencyCode = createFieldSetter(setConditionField, "currencyCode");
  const setMinQtyPerProduct = createFieldSetter(setConditionField, "minQtyPerProduct");

  if (!offer) return <NotFound message="Offer not found." />;

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerTarget === "exclude" ? "Select Products to Exclude" : "Select Required Products"}
        mode="variants"
        allowMultiple
        selectedIds={pickerTarget === "exclude" ? excludeVariantGids : requiredVariantGids}
        onSelect={(gids) => {
          if (pickerTarget === "exclude") setExcludeVariantGids(gids);
          else setRequiredVariantGids(gids);
        }}
      />

      <div className="b-page">
        {/* Action feedback banners */}
        {actionData && "error" in actionData && actionData.error && (
          <div className="b-banner b-banner-red b-mb-4">
            <span className="b-banner-icon">⚠</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
            </div>
          </div>
        )}
        {actionData && "success" in actionData && actionData.success && (
          <div className="b-banner b-banner-green b-mb-4">
            <span className="b-banner-icon">✓</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>Saved successfully.</p>
            </div>
          </div>
        )}

        {/* Page Header */}
        <PageHeader
          title="Conditions"
          subtitle={offer.internalName}
          backTo={`/app/offers/${offer.id}`}
          actions={<Link to={`/app/offers/${offer.id}/rewards`} className="b-btn b-btn-primary">Rewards →</Link>}
        />

        {/* No-conditions warning */}
        {conditions.length === 0 && (
          <div className="b-banner b-banner-orange b-mb-4">
            <span className="b-banner-icon">&#9888;</span>
            <div className="b-banner-body">
              <p className="b-banner-title">No conditions — this offer will always qualify</p>
              <p className="b-banner-text">Add at least one main condition before publishing.</p>
            </div>
          </div>
        )}

        {/* Conditions list card */}
        <div className="b-card">
          <div className="b-card-header">Conditions</div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">
              {conditions.map((c) => (
                <div
                  key={c.id}
                  className="b-row-between"
                  style={{
                    padding: "12px 16px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r)",
                    background: "var(--bg-card)",
                  }}
                >
                  <div className="b-row b-gap-3">
                    <span
                      className={
                        c.scope === "main"
                          ? "b-badge b-badge-blue"
                          : "b-badge b-badge-orange"
                      }
                    >
                      {c.scope}
                    </span>
                    <span className="b-text-bold">{c.conditionType}</span>
                    <span className="b-text-sm b-text-sub">
                      {JSON.stringify(c.value)}
                    </span>
                  </div>
                  <Form method="POST"
                    onSubmit={(e) => { if (!window.confirm("Remove this condition?")) e.preventDefault(); }}>
                    <input type="hidden" name="intent" value="delete_condition" />
                    <input type="hidden" name="conditionId" value={c.id} />
                    <button
                      type="submit"
                      className="b-btn b-btn-danger b-btn-sm"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? "…" : "Remove"}
                    </button>
                  </Form>
                </div>
              ))}

              {/* Add buttons */}
              <div className="b-row b-gap-3" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => { setAddingScope("main"); setSelectedType(""); }}
                >
                  + Add Main Condition
                </button>
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => { setAddingScope("sub"); setSelectedType(""); }}
                >
                  + Add Sub-Condition
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Add condition form card */}
        {addingScope && (
          <div className="b-card b-mt-4">
            <div className="b-card-header">
              Add {addingScope === "main" ? "Main" : "Sub"} Condition
            </div>
            <div className="b-card-body">
              <Form method="POST">
                <input type="hidden" name="intent" value="add_condition" />
                <input type="hidden" name="scope" value={addingScope} />

                <div className="b-stack b-stack-3">
                  {/* Condition type select */}
                  <div>
                    <label className="b-label" htmlFor="conditionType">
                      Condition Type
                    </label>
                    <select
                      id="conditionType"
                      name="conditionType"
                      className="b-select"
                      value={selectedType}
                      onChange={(e) => setSelectedType(e.target.value)}
                    >
                      <option value="">— Select —</option>
                      {(addingScope === "main" ? MAIN_CONDITION_TYPES : SUB_CONDITION_TYPES).map(
                        (opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        )
                      )}
                    </select>
                  </div>

                  {/* cart_value / cart_value_multiplier fields */}
                  {(selectedType === "cart_value" || selectedType === "cart_value_multiplier") && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="threshold">Threshold ($)</label>
                        <input
                          id="threshold"
                          type="number"
                          name="threshold"
                          className="b-input"
                          min="0"
                          step="0.01"
                          required
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="currencyCode">Currency Code</label>
                        <input
                          id="currencyCode"
                          type="text"
                          name="currencyCode"
                          className="b-input"
                          value={currencyCode}
                          onChange={(e) => setCurrencyCode(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      {selectedType === "cart_value_multiplier" && (
                        <div>
                          <label className="b-label" htmlFor="maxMultiplier">Max multiplier (optional)</label>
                          <input
                            id="maxMultiplier"
                            type="number"
                            name="maxMultiplier"
                            className="b-input"
                            autoComplete="off"
                          />
                        </div>
                      )}
                    </>
                  )}

                  {/* cart_quantity fields */}
                  {selectedType === "cart_quantity" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="minQty">Min quantity</label>
                        <input
                          id="minQty"
                          type="number"
                          name="minQty"
                          className="b-input"
                          min="1"
                          required
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="maxQty">Max quantity (optional)</label>
                        <input
                          id="maxQty"
                          type="number"
                          name="maxQty"
                          className="b-input"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}

                  {/* specific_product / pack_of_products — product picker */}
                  {(selectedType === "specific_product" || selectedType === "pack_of_products") && (
                    <div className="b-stack b-stack-3">
                      <p className="b-text-bold" style={{ margin: 0 }}>
                        {selectedType === "specific_product"
                          ? "Required products"
                          : "Pack products (all must be present)"}
                      </p>
                      <div className="b-row b-gap-2" style={{ flexWrap: "wrap" }}>
                        {requiredVariantGids.map((gid) => (
                          <span
                            key={gid}
                            className="b-badge b-badge-gray"
                            style={{ gap: 6 }}
                          >
                            {gid.split("/").pop()}
                            <button
                              type="button"
                              onClick={() =>
                                setRequiredVariantGids((prev) => prev.filter((g) => g !== gid))
                              }
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                padding: 0,
                                lineHeight: 1,
                                color: "var(--text-sub)",
                                fontSize: 14,
                              }}
                              aria-label="Remove"
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        onClick={() => { setPickerTarget("required"); setPickerOpen(true); }}
                      >
                        + Select Products
                      </button>
                      <input type="hidden" name="requiredVariantGids" value={requiredVariantGids.join(",")} />
                      <div>
                        <label className="b-label" htmlFor="minQtyPerProduct">Min quantity per product</label>
                        <input
                          id="minQtyPerProduct"
                          type="number"
                          name="minQtyPerProduct"
                          className="b-input"
                          value={minQtyPerProduct}
                          onChange={(e) => setMinQtyPerProduct(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}

                  {/* exclude_products — product picker */}
                  {selectedType === "exclude_products" && (
                    <div className="b-stack b-stack-3">
                      <p className="b-text-bold" style={{ margin: 0 }}>Excluded products</p>
                      <div className="b-row b-gap-2" style={{ flexWrap: "wrap" }}>
                        {excludeVariantGids.map((gid) => (
                          <span
                            key={gid}
                            className="b-badge b-badge-gray"
                            style={{ gap: 6 }}
                          >
                            {gid.split("/").pop()}
                            <button
                              type="button"
                              onClick={() =>
                                setExcludeVariantGids((prev) => prev.filter((g) => g !== gid))
                              }
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                padding: 0,
                                lineHeight: 1,
                                color: "var(--text-sub)",
                                fontSize: 14,
                              }}
                              aria-label="Remove"
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        onClick={() => { setPickerTarget("exclude"); setPickerOpen(true); }}
                      >
                        + Select Products to Exclude
                      </button>
                      <input type="hidden" name="excludeVariantGids" value={excludeVariantGids.join(",")} />
                    </div>
                  )}

                  {/* customer_tags fields */}
                  {selectedType === "customer_tags" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="includeTags">Include tags (comma-separated)</label>
                        <input
                          id="includeTags"
                          type="text"
                          name="includeTags"
                          className="b-input"
                          autoComplete="off"
                          placeholder="vip, wholesale"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="excludeTags">Exclude tags (comma-separated)</label>
                        <input
                          id="excludeTags"
                          type="text"
                          name="excludeTags"
                          className="b-input"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}

                  {/* customer_location fields */}
                  {selectedType === "customer_location" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="includeCountries">Include country codes (comma-separated)</label>
                        <input
                          id="includeCountries"
                          type="text"
                          name="includeCountries"
                          className="b-input"
                          autoComplete="off"
                          placeholder="US, CA, GB"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="excludeCountries">Exclude country codes (comma-separated)</label>
                        <input
                          id="excludeCountries"
                          type="text"
                          name="excludeCountries"
                          className="b-input"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}

                  {/* markets fields */}
                  {selectedType === "markets" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="includeMarkets">Include Market IDs (comma-separated)</label>
                        <input
                          id="includeMarkets"
                          type="text"
                          name="includeMarkets"
                          className="b-input"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="excludeMarkets">Exclude Market IDs (comma-separated)</label>
                        <input
                          id="excludeMarkets"
                          type="text"
                          name="excludeMarkets"
                          className="b-input"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}

                  {/* order_history_total_spent field */}
                  {selectedType === "order_history_total_spent" && (
                    <div>
                      <label className="b-label" htmlFor="orderValue">Minimum total spent ($)</label>
                      <input
                        id="orderValue"
                        type="number"
                        name="orderValue"
                        className="b-input"
                        autoComplete="off"
                      />
                    </div>
                  )}

                  {/* Add / Cancel buttons — only shown once a type is selected */}
                  {selectedType && (
                    <div className="b-row b-gap-3" style={{ marginTop: 4 }}>
                      <button
                        type="submit"
                        className="b-btn b-btn-primary"
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "Adding…" : "Add Condition"}
                      </button>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary"
                        onClick={() => setAddingScope(null)}
                        disabled={isSubmitting}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </Form>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
