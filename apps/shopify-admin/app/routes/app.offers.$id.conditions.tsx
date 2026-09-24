/**
 * Offer Conditions Editor — Step 2-3 of the offer builder wizard.
 * Allows adding/editing main conditions and subconditions with a
 * validated form for each condition type.
 */

import { useLoaderData, Form, Link, useActionData, useNavigation } from "react-router";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offerConditions } from "@promo/db";
import {
  CART_ATTRIBUTE_KEYS,
  ConditionTypeSchema,
  LINE_ATTRIBUTE_KEYS,
  validateConditionValue,
  type ConditionOperator,
} from "@promo/shared-types";
import { and, eq } from "drizzle-orm";
import { republishIfActive } from "../lib/offer-publish-flow.server.js";
import { getMarketsForShop } from "../lib/markets.server.js";
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
  const markets = await getMarketsForShop(shopId).catch(() => []);

  return {
    offer,
    conditions: conditionRows.sort((a, b) => a.sortOrder - b.sortOrder),
    markets,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  if (intent === "add_condition") {
    const conditionType = formData.get("conditionType") as string;
    const conditionTypeResult = ConditionTypeSchema.safeParse(conditionType);
    if (!conditionTypeResult.success) return { error: "Condition type is invalid." };
    const scopeRaw = formData.get("scope") as string | null;
    const scope = scopeRaw === "sub" ? "sub" : "main";

    // Build value object based on condition type
    let value: Record<string, unknown> = {};
    let conditionOperator: ConditionOperator = "gte";
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
      case "order_history_total_spent":
      case "order_history_last_order_spent":
      case "order_history_total_orders": {
        const orderVal = parseFloat(formData.get("orderValue") as string);
        if (!Number.isFinite(orderVal) || orderVal < 0) return { error: "Order value must be a valid positive number." };
        const operatorValue = String(formData.get("operator") ?? "gte");
        conditionOperator = ["eq", "gt", "gte", "lt", "lte"].includes(operatorValue)
          ? operatorValue as ConditionOperator
          : "gte";
        const historyType = conditionType === "order_history_total_orders"
          ? "total_orders"
          : conditionType === "order_history_last_order_spent"
            ? "last_order_spent"
            : "total_spent";
        value = {
          type: historyType,
          operator: conditionOperator,
          ...(historyType === "total_orders" ? { value: Math.floor(orderVal) } : { valueCents: Math.round(orderVal * 100) }),
        };
        break;
      }
      case "one_use_per_customer":
        value = {};
        break;
      case "markets":
        {
          const includeMarketIds = splitCsvList(formData.get("includeMarkets") as string | null);
          const excludeMarketIds = splitCsvList(formData.get("excludeMarkets") as string | null);
          if (includeMarketIds.length === 0 && excludeMarketIds.length === 0) return { error: "Select at least one Shopify Market." };
          value = { includeMarketIds, excludeMarketIds };
        }
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
      case "subscription_product_type":
        value = { mode: formData.get("subscriptionMode") ?? "subscription_only" };
        break;
      case "specific_link": {
        const requiredUrl = String(formData.get("requiredUrl") ?? "").trim();
        const paramName = String(formData.get("paramName") ?? "").trim();
        const paramValue = String(formData.get("paramValue") ?? "");
        value = {
          requiredUrl,
          ...(paramName ? { paramName } : {}),
          ...(paramValue ? { paramValue } : {}),
        };
        break;
      }
      case "page_url": {
        const patternsRaw = formData.get("urlPatterns") as string | null;
        const patterns = splitCsvList(patternsRaw).filter((p) => p.length > 0);
        if (patterns.length === 0) return { error: "Enter at least one URL pattern." };
        const matchMode = (formData.get("matchMode") as string | null) ?? "starts_with";
        value = { patterns, matchMode, caseSensitive: false };
        break;
      }
      case "specific_product":
      case "pack_of_products": {
        const gidsRaw = (formData.get("requiredVariantGids") as string | null) ?? "";
        const variantIds = splitCsvList(gidsRaw);
        if (variantIds.length === 0) {
          // Return early with validation error rather than inserting an empty condition
          return { error: "Select at least one product before adding this condition." };
        }
        const minQty = parseInt((formData.get("minQtyPerProduct") as string | null) ?? "1", 10) || 1;
        value = conditionType === "pack_of_products"
          ? {
              requirements: variantIds.map((variantId) => ({
                variantId,
                trackMode: "variant",
                quantityPerPack: minQty,
              })),
              multiplyByPacks: false,
            }
          : {
              requirements: variantIds.map((variantId) => ({
                variantId,
                trackMode: "variant",
                minQuantity: minQty,
              })),
              multiplyByGroups: false,
            };
        break;
      }
      case "line_attribute":
        value = {
          key: String(formData.get("attributeKey") ?? ""),
          value: String(formData.get("attributeValue") ?? "").trim(),
          matchMode: formData.get("attributeMatchMode") === "not_equals" ? "not_equals" : "equals",
          minMatchingQuantity: Math.max(1, parseInt(String(formData.get("attributeMinQuantity") ?? "1"), 10) || 1),
        };
        break;
      case "cart_attribute":
        value = {
          key: String(formData.get("attributeKey") ?? ""),
          value: String(formData.get("attributeValue") ?? "").trim(),
          matchMode: formData.get("attributeMatchMode") === "not_equals" ? "not_equals" : "equals",
        };
        break;
    }

    const valueResult = validateConditionValue(conditionType, value);
    if (!valueResult.success) return { error: valueResult.error.issues[0]?.message ?? "Condition value is invalid." };

    const existingCount = await db.select({ id: offerConditions.id })
      .from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));

    await db.insert(offerConditions).values({
      shopId, offerId,
      scope,
      conditionType,
      operator: conditionOperator,
      value,
      sortOrder: existingCount.length,
      isEnabled: true,
    });
    const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
    if (publishError) return { error: publishError };
  }

  if (intent === "delete_condition") {
    const conditionId = formData.get("conditionId") as string;
    if (offer.status === "active") {
      const [conditionToDelete, mainConditions] = await Promise.all([
        db.select({ scope: offerConditions.scope, isEnabled: offerConditions.isEnabled })
          .from(offerConditions)
          .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)))
          .limit(1),
        db.select({ id: offerConditions.id })
          .from(offerConditions)
          .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "main"), eq(offerConditions.isEnabled, true))),
      ]);
      if (conditionToDelete[0]?.scope === "main" && conditionToDelete[0].isEnabled && mainConditions.length <= 1) {
        return { error: "Cannot delete the last enabled main condition from an active offer. Pause it first or add another main condition." };
      }
    }
    await db.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)));
    const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
    if (publishError) return { error: publishError };
  }

  return { success: true };
};

const MAIN_CONDITION_TYPES = [
  { label: "Cart Value — spend threshold", value: "cart_value" },
  { label: "Cart Quantity — item count threshold", value: "cart_quantity" },
  { label: "Cart Value Multiplier — earn gifts per $ spent", value: "cart_value_multiplier" },
  { label: "Specific Product — must contain selected products", value: "specific_product" },
  { label: "Pack of Products — all products must be present", value: "pack_of_products" },
  { label: "Page URL — restrict to specific storefront pages", value: "page_url" },
  { label: "Line attribute — approved legacy property", value: "line_attribute" },
  { label: "Cart attribute — approved legacy property", value: "cart_attribute" },
];

const SUB_CONDITION_TYPES = [
  { label: "Customer Tags", value: "customer_tags" },
  { label: "Order History — total spent", value: "order_history_total_spent" },
  { label: "Order History — last order spent", value: "order_history_last_order_spent" },
  { label: "Order History — total orders", value: "order_history_total_orders" },
  { label: "One Use Per Customer", value: "one_use_per_customer" },
  { label: "Shopify Markets", value: "markets" },
  { label: "Country / IP location", value: "customer_location" },
  { label: "Sales Channel", value: "sales_channels" },
  { label: "Subscription Products Only", value: "subscription_product_type" },
  { label: "Specific Link / Magic URL", value: "specific_link" },
];

export default function OfferConditionsPage() {
  const { offer, conditions, markets } = useLoaderData<typeof loader>();
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
    includeMarketIds: [] as string[],
    excludeMarketIds: [] as string[],
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
    includeMarketIds,
    excludeMarketIds,
  } = conditionState;
  const setAddingScope = createFieldSetter(setConditionField, "addingScope");
  const setSelectedType = createFieldSetter(setConditionField, "selectedType");
  const setPickerOpen = createFieldSetter(setConditionField, "pickerOpen");
  const setPickerTarget = createFieldSetter(setConditionField, "pickerTarget");
  const setRequiredVariantGids = createFieldSetter(setConditionField, "requiredVariantGids");
  const setExcludeVariantGids = createFieldSetter(setConditionField, "excludeVariantGids");
  const setCurrencyCode = createFieldSetter(setConditionField, "currencyCode");
  const setMinQtyPerProduct = createFieldSetter(setConditionField, "minQtyPerProduct");
  const setIncludeMarketIds = createFieldSetter(setConditionField, "includeMarketIds");
  const setExcludeMarketIds = createFieldSetter(setConditionField, "excludeMarketIds");

  function setMarketDisposition(marketId: string, disposition: "" | "include" | "exclude") {
    setIncludeMarketIds((current) => disposition === "include"
      ? [...new Set([...current, marketId])]
      : current.filter((id) => id !== marketId));
    setExcludeMarketIds((current) => disposition === "exclude"
      ? [...new Set([...current, marketId])]
      : current.filter((id) => id !== marketId));
  }

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
                    onSubmit={(e: React.FormEvent<HTMLFormElement>) => { if (!window.confirm("Remove this condition?")) e.preventDefault(); }}>
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

                  {(selectedType === "line_attribute" || selectedType === "cart_attribute") && (
                    <div className="b-stack b-stack-3">
                      <div>
                        <label className="b-label" htmlFor="attributeKey">Attribute key</label>
                        <input id="attributeKey" name="attributeKey" className="b-input" list="attribute-key-suggestions" required autoComplete="off" placeholder={selectedType === "cart_attribute" ? "affiliate_campaign" : "engraving_message"} />
                        <datalist id="attribute-key-suggestions">
                          {(selectedType === "cart_attribute" ? CART_ATTRIBUTE_KEYS : LINE_ATTRIBUTE_KEYS).map((key) => (
                            <option key={key} value={key} />
                          ))}
                        </datalist>
                        <p className="b-help">Enter this store's own Shopify attribute key. Existing HPN keys remain available only as migration suggestions.</p>
                      </div>
                      <div><label className="b-label" htmlFor="attributeValue">Required value</label><input id="attributeValue" name="attributeValue" className="b-input" required autoComplete="off" /></div>
                      <div><label className="b-label" htmlFor="attributeMatchMode">Match</label><select id="attributeMatchMode" name="attributeMatchMode" className="b-select"><option value="equals">Equals</option><option value="not_equals">Does not equal</option></select></div>
                      {selectedType === "line_attribute" && <div><label className="b-label" htmlFor="attributeMinQuantity">Minimum matching quantity</label><input id="attributeMinQuantity" name="attributeMinQuantity" className="b-input" type="number" min="1" step="1" defaultValue="1" /></div>}
                    </div>
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
                      <label className="b-checkbox-row">
                        <input type="checkbox" name="treatGuestAsNoTags" defaultChecked />
                        <span>Treat guest customers as having no tags</span>
                      </label>
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
                      <input type="hidden" name="includeMarkets" value={includeMarketIds.join(",")} />
                      <input type="hidden" name="excludeMarkets" value={excludeMarketIds.join(",")} />
                      {markets.length > 0 ? (
                        <div className="b-stack b-stack-2">
                          {markets.map((market) => {
                            const disposition = includeMarketIds.includes(market.id)
                              ? "include"
                              : excludeMarketIds.includes(market.id)
                                ? "exclude"
                                : "";
                            return (
                              <div key={market.id} className="b-row-between" style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "10px 12px" }}>
                                <span className="b-text-sm"><strong>{market.name}</strong> · {market.currencyCode}{market.primary ? " · Primary" : ""}</span>
                                <select className="b-select" aria-label={`Market rule for ${market.name}`} value={disposition} onChange={(event) => setMarketDisposition(market.id, event.target.value as "" | "include" | "exclude")} style={{ width: 130 }}>
                                  <option value="">Ignore</option>
                                  <option value="include">Include</option>
                                  <option value="exclude">Exclude</option>
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="b-banner b-banner-orange">
                          <div className="b-banner-body">
                            <p className="b-banner-title">No Markets available</p>
                            <p className="b-banner-text">Refresh Shopify permissions or configure Markets before adding this condition.</p>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* page_url fields */}
                  {selectedType === "page_url" && (
                    <>
                      <div>
                        <label className="b-label" htmlFor="urlPatterns">URL patterns (comma-separated)</label>
                        <input
                          id="urlPatterns"
                          type="text"
                          name="urlPatterns"
                          className="b-input"
                          autoComplete="off"
                          placeholder="/collections/sale, /pages/promo"
                          required
                        />
                        <div className="b-help">Enter path patterns. The offer activates when the current page matches any pattern.</div>
                      </div>
                      <div>
                        <label className="b-label" htmlFor="matchMode">Match mode</label>
                        <select id="matchMode" name="matchMode" className="b-select">
                          <option value="starts_with">Starts with</option>
                          <option value="exact">Exact match</option>
                          <option value="contains">Contains</option>
                          <option value="ends_with">Ends with</option>
                        </select>
                      </div>
                    </>
                  )}

                  {(selectedType === "order_history_total_spent" || selectedType === "order_history_last_order_spent" || selectedType === "order_history_total_orders") && (
                    <>
                    <div>
                      <label className="b-label" htmlFor="orderValue">
                        {selectedType === "order_history_total_orders" ? "Order count" : "Order amount ($)"}
                      </label>
                      <input
                        id="orderValue"
                        type="number"
                        name="orderValue"
                        className="b-input"
                        autoComplete="off"
                        min="0"
                        step={selectedType === "order_history_total_orders" ? "1" : "0.01"}
                        required
                      />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="operator">Comparison</label>
                      <select id="operator" name="operator" className="b-select" defaultValue="gte">
                        <option value="gte">At least</option>
                        <option value="gt">Greater than</option>
                        <option value="eq">Exactly</option>
                        <option value="lte">At most</option>
                        <option value="lt">Less than</option>
                      </select>
                    </div>
                    </>
                  )}

                  {selectedType === "subscription_product_type" && (
                    <div>
                      <label className="b-label" htmlFor="subscriptionMode">Purchase type</label>
                      <select id="subscriptionMode" name="subscriptionMode" className="b-select" defaultValue="subscription_only">
                        <option value="subscription_only">Subscription products</option>
                        <option value="one_time_only">One-time purchase products</option>
                        <option value="any">Any purchase type</option>
                      </select>
                    </div>
                  )}

                  {selectedType === "sales_channels" && (
                    <fieldset className="b-stack b-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend className="b-label">Allowed sales channels</legend>
                      {[["online_store", "Online store"], ["mobile_app", "Mobile app"], ["pos", "Point of sale"]].map(([value, label]) => (
                        <label key={value} className="b-checkbox-row">
                          <input type="checkbox" name="channels[]" value={value} defaultChecked={value === "online_store"} />
                          <span>{label}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  {selectedType === "specific_link" && (
                    <div className="b-stack b-stack-3">
                      <div>
                        <label className="b-label" htmlFor="requiredUrl">Required storefront URL or path</label>
                        <input id="requiredUrl" name="requiredUrl" className="b-input" placeholder="/pages/vip" autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="paramName">Query parameter (optional)</label>
                        <input id="paramName" name="paramName" className="b-input" placeholder="code" autoComplete="off" />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="paramValue">Expected parameter value (optional)</label>
                        <input id="paramValue" name="paramValue" className="b-input" placeholder="summer" autoComplete="off" />
                      </div>
                      <p className="b-help">The storefront runtime evaluates the current browser URL. Shopify Functions cannot read a browser URL directly.</p>
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
