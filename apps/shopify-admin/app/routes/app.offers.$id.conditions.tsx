/**
 * Offer Conditions Editor — Step 2-3 of the offer builder wizard.
 * Allows adding/editing main conditions and subconditions with a
 * validated form for each condition type.
 */

import { parseUuidParam } from "../lib/route-params.js";
import { useLoaderData, Form, Link, useActionData, useNavigation, useSubmit } from "react-router";
import * as Sentry from "@sentry/node";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { SelectedProductsList, type SelectedProduct } from "../components/SelectedProductsList.js";
import { MatchBySelect, ProductConditionNote, pickedItems } from "../components/ProductConditionFields.js";
import { buildProductConditionValue, readMatchBy, requirementGids, type MatchBy } from "../lib/product-condition.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { discountCodes, offerConditions } from "@promo/db";
import {
  CART_ATTRIBUTE_KEYS,
  ConditionTypeSchema,
  LINE_ATTRIBUTE_KEYS,
  resolveOnlyMatchedLines,
  resolveRejectUnmatchedLines,
  validateConditionValue,
  type ConditionOperator,
} from "@promo/shared-types";
import {
  OnlyMatchedLinesCheckbox,
  PAGE_TYPES_HELP,
  PageTypeCheckboxes,
  RejectUnmatchedLinesCheckbox,
  UtmScopeChoice,
} from "../components/subconditions/forms.js";
import { DEFAULT_CODE_PAGE_TYPES, readPageTypes } from "../lib/page-types.js";
import { and, eq } from "drizzle-orm";
import { republishIfActive } from "../lib/offer-publish-flow.server.js";
import { getMarketsForShop } from "../lib/markets.server.js";
import { conditionSummary, conditionTypeLabel } from "../lib/offer-summaries.js";
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

function lineMatchFlags(formData: FormData) {
  return {
    onlyMatchedLines: formData.get("onlyMatchedLines") === "on",
    rejectUnmatchedLines: formData.get("rejectUnmatchedLines") === "on",
  };
}

function LineMatchFields({
  defaultOnlyMatchedLines,
  defaultRejectUnmatchedLines,
}: {
  defaultOnlyMatchedLines: boolean;
  defaultRejectUnmatchedLines: boolean;
}) {
  return (
    <>
      <OnlyMatchedLinesCheckbox id="onlyMatchedLines" name="onlyMatchedLines" defaultChecked={defaultOnlyMatchedLines} />
      <RejectUnmatchedLinesCheckbox
        id="rejectUnmatchedLines"
        name="rejectUnmatchedLines"
        defaultChecked={defaultRejectUnmatchedLines}
      />
    </>
  );
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const conditionRows = await db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
  const markets = await getMarketsForShop(shopId).catch((error) => {
    Sentry.captureException(error, { tags: { route: "app.offers.$id.conditions", query: "getMarketsForShop" } });
    return [];
  });

  const [firstCode] = await db
    .select({ id: discountCodes.id })
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId)))
    .limit(1);

  return {
    offer,
    conditions: conditionRows.sort((a, b) => a.sortOrder - b.sortOrder),
    markets,
    isCodePromo: Boolean(firstCode) || Boolean(offer.requiredDiscountCode) || offer.requiresCode,
  };
};

function buildConditionValue(
  conditionType: string,
  formData: FormData,
): { value: Record<string, unknown>; operator: ConditionOperator; error?: never } | { error: string; value?: never; operator?: never } {
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
          ...lineMatchFlags(formData),
        };
        break;
      }
      case "page_types": {
        const pageTypes = formData.getAll("pageTypes").map(String);
        if (pageTypes.length === 0) return { error: "Select at least one kind of store page." };
        value = { pageTypes, ...lineMatchFlags(formData) };
        break;
      }
      case "page_url": {
        const patternsRaw = formData.get("urlPatterns") as string | null;
        const patterns = splitCsvList(patternsRaw).filter((p) => p.length > 0);
        if (patterns.length === 0) return { error: "Enter at least one URL pattern." };
        const matchMode = (formData.get("matchMode") as string | null) ?? "starts_with";
        value = { patterns, matchMode, caseSensitive: false, ...lineMatchFlags(formData) };
        break;
      }
      case "specific_product":
      case "pack_of_products": {
        const matchBy: MatchBy = formData.get("matchBy") === "product" ? "product" : "variant";
        const gids = splitCsvList((formData.get(matchBy === "product" ? "requiredProductGids" : "requiredVariantGids") as string | null) ?? "");
        if (gids.length === 0) {
          // Return early with validation error rather than inserting an empty condition
          return { error: "Select at least one product before adding this condition." };
        }
        const minQty = parseInt((formData.get("minQtyPerProduct") as string | null) ?? "1", 10) || 1;
        value = buildProductConditionValue(conditionType, matchBy, gids, minQty);
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
      case "discount_code":
        return { error: "Discount codes are managed on the offer's Codes tab, not as a condition." };
      case "utm_parameters":
        value = {
          utmSource: String(formData.get("utmSource") ?? "").trim(),
          utmMedium: String(formData.get("utmMedium") ?? "").trim(),
          utmCampaign: String(formData.get("utmCampaign") ?? "").trim(),
          utmTerm: String(formData.get("utmTerm") ?? "").trim(),
          utmContent: String(formData.get("utmContent") ?? "").trim(),
          scope: formData.get("utmScope") === "visit" ? "visit" : "page",
          ...lineMatchFlags(formData),
        };
        break;
    }

    const valueResult = validateConditionValue(conditionType, value);
    if (!valueResult.success) return { error: valueResult.error.issues[0]?.message ?? "Condition value is invalid." };

    return { value, operator: conditionOperator };
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  if (intent === "add_condition" || intent === "update_condition") {
    const conditionType = formData.get("conditionType") as string;
    const conditionTypeResult = ConditionTypeSchema.safeParse(conditionType);
    if (!conditionTypeResult.success) return { error: "Condition type is invalid." };
    const scopeRaw = formData.get("scope") as string | null;
    const scope = scopeRaw === "sub" ? "sub" : "main";

    const built = buildConditionValue(conditionType, formData);
    if ("error" in built) return { error: built.error };
    const { value, operator: conditionOperator } = built;

    if (intent === "add_condition") {
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
    } else {
      const conditionId = formData.get("conditionId") as string;
      if (!conditionId) return { error: "Condition ID missing." };
      await db.update(offerConditions)
        .set({ scope, conditionType, operator: conditionOperator, value })
        .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)));
    }
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
  { label: "Specific Product — cart must contain every selected variant/product", value: "specific_product" },
  { label: "Pack of Products — every product in the pack must be present", value: "pack_of_products" },
  { label: "Page URL — restrict to specific storefront pages", value: "page_url" },
  { label: "Store pages — products added from home, collections, product pages…", value: "page_types" },
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
  { label: "UTM Parameters", value: "utm_parameters" },
  { label: "Store pages", value: "page_types" },
];

/** Pulls the edit-form-relevant fields out of a condition's stored value —
 * shared by startEditCondition and the initial state below, so the first
 * condition can open pre-filled exactly like a real click would produce. */
function deriveConditionEditFields(value: Record<string, unknown>) {
  const currencyCode = typeof value["currencyCode"] === "string" ? (value["currencyCode"] as string) : "USD";
  const includeMarketIds = Array.isArray(value["includeMarketIds"]) ? (value["includeMarketIds"] as string[]) : [];
  const excludeMarketIds = Array.isArray(value["excludeMarketIds"]) ? (value["excludeMarketIds"] as string[]) : [];
  let requiredVariantGids: string[] = [];
  let minQtyPerProduct = "1";
  const matchBy = readMatchBy(value);
  const requiredProductGids = matchBy === "product" ? requirementGids(value) : [];
  if (Array.isArray(value["requirements"])) {
    const requirements = value["requirements"] as Array<Record<string, unknown>>;
    requiredVariantGids = matchBy === "variant" ? requirementGids(value) : [];
    const firstQty = requirements[0]?.["quantityPerPack"] ?? requirements[0]?.["minQuantity"];
    minQtyPerProduct = typeof firstQty === "number" ? String(firstQty) : "1";
  }
  return { currencyCode, includeMarketIds, excludeMarketIds, requiredVariantGids, requiredProductGids, matchBy, minQtyPerProduct };
}

export default function OfferConditionsPage() {
  const { offer, conditions, markets, isCodePromo } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state !== "idle";
  const [conditionState, setConditionField] = useObjectState(() => {
    // Open the first condition's edit form by default, so it's immediately
    // obvious these rows are clickable and what clicking one reveals —
    // instead of a wall of collapsed summaries with no visible affordance.
    const first = conditions[0];
    const fields = first ? deriveConditionEditFields((first.value ?? {}) as Record<string, unknown>) : null;
    return {
      addingScope: (first?.scope as "main" | "sub" | undefined) ?? null,
      editingId: first?.id ?? null,
      selectedType: first?.conditionType ?? "",
      pickerOpen: false,
      pickerTarget: "required" as "required" | "exclude" | "gift",
      requiredVariantGids: fields?.requiredVariantGids ?? [],
      requiredProductGids: fields?.requiredProductGids ?? [],
      matchBy: (fields?.matchBy ?? "variant") as MatchBy,
      pickedProducts: [] as SelectedProduct[],
      excludeVariantGids: [] as string[],
      currencyCode: fields?.currencyCode ?? "USD",
      minQtyPerProduct: fields?.minQtyPerProduct ?? "1",
      includeMarketIds: fields?.includeMarketIds ?? [],
      excludeMarketIds: fields?.excludeMarketIds ?? [],
      confirmDeleteConditionId: null as string | null,
    };
  });
  const {
    addingScope,
    editingId,
    selectedType,
    pickerOpen,
    pickerTarget,
    requiredVariantGids,
    requiredProductGids,
    matchBy,
    pickedProducts,
    excludeVariantGids,
    currencyCode,
    minQtyPerProduct,
    includeMarketIds,
    excludeMarketIds,
    confirmDeleteConditionId,
  } = conditionState;
  const setConfirmDeleteConditionId = createFieldSetter(setConditionField, "confirmDeleteConditionId");
  const setAddingScope = createFieldSetter(setConditionField, "addingScope");
  const setEditingId = createFieldSetter(setConditionField, "editingId");
  const setSelectedType = createFieldSetter(setConditionField, "selectedType");
  const setPickerOpen = createFieldSetter(setConditionField, "pickerOpen");
  const setPickerTarget = createFieldSetter(setConditionField, "pickerTarget");
  const setRequiredVariantGids = createFieldSetter(setConditionField, "requiredVariantGids");
  const setRequiredProductGids = createFieldSetter(setConditionField, "requiredProductGids");
  const setMatchBy = createFieldSetter(setConditionField, "matchBy");
  const setPickedProducts = createFieldSetter(setConditionField, "pickedProducts");
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

  function closeConditionForm() {
    setAddingScope(null);
    setEditingId(null);
    setSelectedType("");
  }

  function startEditCondition(c: (typeof conditions)[number]) {
    if (editingId === c.id) {
      closeConditionForm();
      return;
    }
    const value = (c.value ?? {}) as Record<string, unknown>;
    const fields = deriveConditionEditFields(value);
    setAddingScope(c.scope as "main" | "sub");
    setSelectedType(c.conditionType);
    setEditingId(c.id);
    setCurrencyCode(fields.currencyCode);
    setIncludeMarketIds(fields.includeMarketIds);
    setExcludeMarketIds(fields.excludeMarketIds);
    setRequiredVariantGids(fields.requiredVariantGids);
    setRequiredProductGids(fields.requiredProductGids);
    setMatchBy(fields.matchBy);
    setMinQtyPerProduct(fields.minQtyPerProduct);
  }

  const editingCondition = editingId ? conditions.find((c) => c.id === editingId) : undefined;
  const editingValue = (editingCondition?.value ?? {}) as Record<string, unknown>;
  const defaultOnlyMatchedLines = resolveOnlyMatchedLines(editingValue["onlyMatchedLines"], isCodePromo);
  const defaultRejectUnmatchedLines = resolveRejectUnmatchedLines(editingValue["rejectUnmatchedLines"]);
  const editingPageTypes = editingCondition ? readPageTypes(editingValue["pageTypes"]) : DEFAULT_CODE_PAGE_TYPES;

  if (!offer) return <NotFound message="Offer not found." />;

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerTarget === "exclude" ? "Select Products to Exclude" : matchBy === "product" ? "Select Required Products" : "Select Required Variants"}
        mode={pickerTarget !== "exclude" && matchBy === "product" ? "products" : "variants"}
        allowMultiple
        selectedIds={pickerTarget === "exclude" ? excludeVariantGids : matchBy === "product" ? requiredProductGids : requiredVariantGids}
        onSelect={(gids) => {
          if (pickerTarget === "exclude") setExcludeVariantGids(gids);
          else if (matchBy === "product") setRequiredProductGids(gids);
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
          <div className="b-banner b-banner-green b-mb-4" role="status">
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

        {/* Code-gated offer explainer */}
        {isCodePromo && (
          <div className="b-banner b-banner-blue b-mb-4" role="status">
            <span className="b-banner-icon">&#9432;</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>
                This offer only applies while the customer has one of its{" "}
                <Link to={`/app/offers/${offer.id}/codes`}>discount codes</Link> entered. Any conditions
                you add below apply IN ADDITION to that. For example, add a landing-page, UTM or magic-link
                condition here to also require the customer came from a specific source; only the products
                added from that page get the discount.
              </p>
            </div>
          </div>
        )}

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
            {conditions.length > 0 && (
              <p className="b-text-sm b-text-sub" style={{ marginTop: 0, marginBottom: 12 }}>
                Click any condition below to view or edit its details.
              </p>
            )}
            <div className="b-stack b-stack-3">
              {conditions.map((c) => {
                const isEditingThis = editingId === c.id;
                return (
                  <div
                    key={c.id}
                    className="b-row-between"
                    role="button"
                    tabIndex={0}
                    aria-expanded={isEditingThis}
                    onClick={() => startEditCondition(c)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEditCondition(c); } }}
                    style={{
                      padding: "12px 16px",
                      border: isEditingThis ? "1px solid var(--text)" : "1px solid var(--border)",
                      borderRadius: "var(--r)",
                      background: isEditingThis ? "var(--bg-active)" : "var(--bg-card)",
                      cursor: "pointer",
                    }}
                  >
                    <div className="b-row b-gap-3" style={{ flexWrap: "wrap" }}>
                      <span
                        className={
                          c.scope === "main"
                            ? "b-badge b-badge-blue"
                            : "b-badge b-badge-orange"
                        }
                      >
                        {c.scope}
                      </span>
                      <span className="b-text-bold">{conditionTypeLabel(c.conditionType)}</span>
                      <span className="b-text-sm b-text-sub">
                        {conditionSummary(c.conditionType, c.value)}
                      </span>
                      <span className="b-text-sm b-text-sub" style={{ fontWeight: 600 }}>
                        {isEditingThis ? "▲ Hide details" : "Click to view details ▾"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="b-btn b-btn-danger b-btn-sm"
                      disabled={isSubmitting}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteConditionId(c.id);
                      }}
                    >
                      {isSubmitting ? "…" : "Remove"}
                    </button>
                  </div>
                );
              })}

              <div className="b-banner b-banner-blue" role="status">
                <span className="b-banner-icon">&#9432;</span>
                <div className="b-banner-body">
                  <p className="b-banner-text" style={{ margin: 0 }}>
                    Main conditions must ALL be true for the offer to trigger (AND logic).
                    Sub-conditions add extra requirements on top and are only checked once
                    every main condition has already passed.
                  </p>
                </div>
              </div>

              {/* Add buttons */}
              <div className="b-row b-gap-3" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => { setEditingId(null); setAddingScope("main"); setSelectedType(""); }}
                >
                  + Add Main Condition
                </button>
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => { setEditingId(null); setAddingScope("sub"); setSelectedType(""); }}
                >
                  + Add Sub-Condition
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Add/edit condition form card */}
        {addingScope && (
          <div className="b-card b-mt-4">
            <div className="b-card-header">
              {editingId ? "Edit Condition" : `Add ${addingScope === "main" ? "Main" : "Sub"} Condition`}
            </div>
            <div className="b-card-body">
              <Form method="POST" key={editingId ?? "new"}>
                <input type="hidden" name="intent" value={editingId ? "update_condition" : "add_condition"} />
                {editingId && <input type="hidden" name="conditionId" value={editingId} />}
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
                          defaultValue={typeof editingValue["thresholdCents"] === "number" ? (editingValue["thresholdCents"] / 100).toFixed(2) : undefined}
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
                            defaultValue={typeof editingValue["maxMultiplier"] === "number" ? editingValue["maxMultiplier"] : undefined}
                          />
                          <p className="b-help">
                            The reward multiplies: floor(cart value ÷ threshold), capped at this max if
                            set. E.g. threshold $50, cart $130 → 2× the reward. Leave blank for no cap.
                          </p>
                        </div>
                      )}
                      <p className="b-help">
                        Calculated from qualifying cart lines only — gift lines are always excluded
                        from the total.
                      </p>
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
                          defaultValue={typeof editingValue["minQuantity"] === "number" ? editingValue["minQuantity"] : undefined}
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
                          defaultValue={typeof editingValue["maxQuantity"] === "number" ? editingValue["maxQuantity"] : undefined}
                        />
                      </div>
                      <p className="b-help">
                        Counts total item quantity across qualifying cart lines (gift lines excluded),
                        not the number of distinct products.
                      </p>
                    </>
                  )}

                  {(selectedType === "line_attribute" || selectedType === "cart_attribute") && (
                    <div className="b-stack b-stack-3">
                      <div>
                        <label className="b-label" htmlFor="attributeKey">Attribute key</label>
                        <input id="attributeKey" name="attributeKey" className="b-input" list="attribute-key-suggestions" required autoComplete="off" placeholder={selectedType === "cart_attribute" ? "affiliate_campaign" : "engraving_message"} defaultValue={typeof editingValue["key"] === "string" ? editingValue["key"] : undefined} />
                        <datalist id="attribute-key-suggestions">
                          {(selectedType === "cart_attribute" ? CART_ATTRIBUTE_KEYS : LINE_ATTRIBUTE_KEYS).map((key) => (
                            <option key={key} value={key} />
                          ))}
                        </datalist>
                        <p className="b-help">Enter this store's own Shopify attribute key. Existing HPN keys remain available only as migration suggestions.</p>
                      </div>
                      <div><label className="b-label" htmlFor="attributeValue">Required value</label><input id="attributeValue" name="attributeValue" className="b-input" required autoComplete="off" defaultValue={typeof editingValue["value"] === "string" ? editingValue["value"] : undefined} /></div>
                      <div>
                        <label className="b-label" htmlFor="attributeMatchMode">Match</label>
                        <select id="attributeMatchMode" name="attributeMatchMode" className="b-select" defaultValue={typeof editingValue["matchMode"] === "string" ? editingValue["matchMode"] : "equals"}><option value="equals">Equals</option><option value="not_equals">Does not equal</option></select>
                        <p className="b-help">
                          "Does not equal" also passes when the {selectedType === "cart_attribute" ? "attribute" : "line property"} is
                          missing entirely — use this to exclude carts/lines tagged a certain way, e.g.
                          requiring <code>__landing_source</code> to not equal a landing page's value.
                        </p>
                      </div>
                      {selectedType === "line_attribute" && <div><label className="b-label" htmlFor="attributeMinQuantity">Minimum matching quantity</label><input id="attributeMinQuantity" name="attributeMinQuantity" className="b-input" type="number" min="1" step="1" defaultValue={typeof editingValue["minMatchingQuantity"] === "number" ? editingValue["minMatchingQuantity"] : 1} /></div>}
                    </div>
                  )}

                  {/* specific_product / pack_of_products — product picker */}
                  {(selectedType === "specific_product" || selectedType === "pack_of_products") && (
                    <div className="b-stack b-stack-3">
                      <MatchBySelect
                        id="matchBy"
                        value={matchBy}
                        onChange={(next) => {
                          if (next === "product" && requiredProductGids.length === 0 && requiredVariantGids.length > 0) {
                            setRequiredProductGids([...new Set(pickedItems(pickedProducts, requiredVariantGids, "variant").flatMap((i) => (i.productId ? [i.productId] : [])))]);
                          }
                          setMatchBy(next);
                        }}
                      />
                      <input type="hidden" name="matchBy" value={matchBy} />
                      <p className="b-text-bold" style={{ margin: 0 }}>
                        {selectedType === "specific_product"
                          ? matchBy === "product" ? "Required products" : "Required variants"
                          : matchBy === "product" ? "Pack products (all must be present)" : "Pack variants (all must be present)"}
                      </p>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        onClick={() => { setPickerTarget("required"); setPickerOpen(true); }}
                      >
                        {matchBy === "product" ? "+ Select Products" : "+ Select Variants"}
                      </button>
                      {/* Resolves real titles/thumbnails instead of showing raw GIDs */}
                      <SelectedProductsList
                        gids={matchBy === "product" ? requiredProductGids : requiredVariantGids}
                        variantMode={matchBy === "variant"}
                        onLoaded={setPickedProducts}
                        onRemove={(gid) => (matchBy === "product" ? setRequiredProductGids : setRequiredVariantGids)((prev) => prev.filter((g) => g !== gid))}
                      />
                      <input type="hidden" name="requiredVariantGids" value={requiredVariantGids.join(",")} />
                      <input type="hidden" name="requiredProductGids" value={requiredProductGids.join(",")} />
                      <div>
                        <label className="b-label" htmlFor="minQtyPerProduct">Min quantity per selected {matchBy === "product" ? "product" : "variant"}</label>
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
                      <ProductConditionNote
                        type={selectedType as "specific_product" | "pack_of_products"}
                        matchBy={matchBy}
                        minQty={parseInt(minQtyPerProduct, 10) || 1}
                        items={pickedItems(pickedProducts, matchBy === "product" ? requiredProductGids : requiredVariantGids, matchBy)}
                      />
                    </div>
                  )}

                  {/* exclude_products — product picker */}
                  {selectedType === "exclude_products" && (
                    <div className="b-stack b-stack-3">
                      <p className="b-text-bold" style={{ margin: 0 }}>Excluded products</p>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        onClick={() => { setPickerTarget("exclude"); setPickerOpen(true); }}
                      >
                        + Select Products to Exclude
                      </button>
                      {/* Resolves real titles/thumbnails instead of showing raw GIDs */}
                      <SelectedProductsList
                        gids={excludeVariantGids}
                        onRemove={(gid) => setExcludeVariantGids((prev) => prev.filter((g) => g !== gid))}
                      />
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
                          defaultValue={Array.isArray(editingValue["includeTags"]) ? (editingValue["includeTags"] as string[]).join(", ") : undefined}
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
                          defaultValue={Array.isArray(editingValue["excludeTags"]) ? (editingValue["excludeTags"] as string[]).join(", ") : undefined}
                        />
                      </div>
                      <label className="b-checkbox-row">
                        <input type="checkbox" name="treatGuestAsNoTags" defaultChecked={editingCondition ? editingValue["treatGuestAsNoTags"] !== false : true} />
                        <span>Treat guest customers as having no tags</span>
                      </label>
                      <p className="b-help">
                        Checked against the customer's real Shopify account tags at checkout, so it
                        can't be spoofed from the browser. With the box above checked, a guest fails an
                        "include" rule and passes an "exclude" rule, exactly as if they had no tags.
                      </p>
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
                          defaultValue={Array.isArray(editingValue["includeCountryCodes"]) ? (editingValue["includeCountryCodes"] as string[]).join(", ") : undefined}
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
                          defaultValue={Array.isArray(editingValue["excludeCountryCodes"]) ? (editingValue["excludeCountryCodes"] as string[]).join(", ") : undefined}
                        />
                      </div>
                      <p className="b-help">
                        Two-letter country codes (US, CA, GB…). The country comes from the buyer's
                        Shopify identity or resolved Market, not raw IP geolocation.
                      </p>
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
                      <p className="b-help">
                        Restricts this offer to (or away from) the buyer's resolved Shopify Market —
                        the same Markets configured under Settings → Markets.
                      </p>
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
                          defaultValue={Array.isArray(editingValue["patterns"]) ? (editingValue["patterns"] as string[]).join(", ") : undefined}
                        />
                        <div className="b-help">Enter path patterns. The offer activates when the current page matches any pattern.</div>
                      </div>
                      <div>
                        <label className="b-label" htmlFor="matchMode">Match mode</label>
                        <select id="matchMode" name="matchMode" className="b-select" defaultValue={typeof editingValue["matchMode"] === "string" ? editingValue["matchMode"] : "starts_with"}>
                          <option value="starts_with">Starts with</option>
                          <option value="exact">Exact match</option>
                          <option value="contains">Contains</option>
                          <option value="ends_with">Ends with</option>
                        </select>
                      </div>
                      <LineMatchFields defaultOnlyMatchedLines={defaultOnlyMatchedLines} defaultRejectUnmatchedLines={defaultRejectUnmatchedLines} />
                    </>
                  )}

                  {selectedType === "page_types" && (
                    <fieldset className="b-stack b-stack-3" style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend className="b-label">Products count when added to the cart from</legend>
                      <PageTypeCheckboxes idPrefix="condition" name="pageTypes" selected={editingPageTypes} />
                      <p className="b-help" style={{ margin: 0 }}>{PAGE_TYPES_HELP}</p>
                      <LineMatchFields defaultOnlyMatchedLines={defaultOnlyMatchedLines} defaultRejectUnmatchedLines={defaultRejectUnmatchedLines} />
                    </fieldset>
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
                        defaultValue={
                          typeof editingValue["value"] === "number"
                            ? editingValue["value"]
                            : typeof editingValue["valueCents"] === "number"
                              ? (editingValue["valueCents"] / 100).toFixed(2)
                              : undefined
                        }
                      />
                    </div>
                    <div>
                      <label className="b-label" htmlFor="operator">Comparison</label>
                      <select id="operator" name="operator" className="b-select" defaultValue={typeof editingValue["operator"] === "string" ? editingValue["operator"] : "gte"}>
                        <option value="gte">At least</option>
                        <option value="gt">Greater than</option>
                        <option value="eq">Exactly</option>
                        <option value="lte">At most</option>
                        <option value="lt">Less than</option>
                      </select>
                    </div>
                    <p className="b-help">
                      Checked against the customer's real Shopify order history at checkout, so it
                      can't be spoofed from the browser. Guests (no account) always fail — they have
                      no order history to compare.
                    </p>
                    </>
                  )}

                  {selectedType === "subscription_product_type" && (
                    <div>
                      <label className="b-label" htmlFor="subscriptionMode">Purchase type</label>
                      <select id="subscriptionMode" name="subscriptionMode" className="b-select" defaultValue={typeof editingValue["mode"] === "string" ? editingValue["mode"] : "subscription_only"}>
                        <option value="subscription_only">Subscription products</option>
                        <option value="one_time_only">One-time purchase products</option>
                        <option value="any">Any purchase type</option>
                      </select>
                      <p className="b-help">
                        Passes as soon as at least one cart line matches — looks at what's actually in
                        the cart right now, not the customer's account or purchase history.
                      </p>
                    </div>
                  )}

                  {selectedType === "sales_channels" && (
                    <fieldset className="b-stack b-stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend className="b-label">Allowed sales channels</legend>
                      {[["online_store", "Online store"], ["mobile_app", "Mobile app"], ["pos", "Point of sale"]].map(([value, label]) => {
                        const editingChannels = Array.isArray(editingValue["channels"]) ? editingValue["channels"] as string[] : null;
                        return (
                          <label key={value} className="b-checkbox-row">
                            <input type="checkbox" name="channels[]" value={value} defaultChecked={editingChannels ? editingChannels.includes(value!) : value === "online_store"} />
                            <span>{label}</span>
                          </label>
                        );
                      })}
                      <p className="b-help">Passes if the order comes from any one of the checked channels (OR, not AND).</p>
                    </fieldset>
                  )}

                  {selectedType === "one_use_per_customer" && (
                    <p className="b-help">
                      No fields to set — this simply limits each logged-in customer to one
                      redemption of this offer, checked against their real order history at
                      checkout. Guests (no account) always fail, since there's no history to check.
                    </p>
                  )}

                  {selectedType === "specific_link" && (
                    <div className="b-stack b-stack-3">
                      <div>
                        <label className="b-label" htmlFor="requiredUrl">Required storefront URL or path</label>
                        <input id="requiredUrl" name="requiredUrl" className="b-input" placeholder="/pages/vip" autoComplete="off" defaultValue={typeof editingValue["requiredUrl"] === "string" ? editingValue["requiredUrl"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="paramName">Query parameter (optional)</label>
                        <input id="paramName" name="paramName" className="b-input" placeholder="code" autoComplete="off" defaultValue={typeof editingValue["paramName"] === "string" ? editingValue["paramName"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="paramValue">Expected parameter value (optional)</label>
                        <input id="paramValue" name="paramValue" className="b-input" placeholder="summer" autoComplete="off" defaultValue={typeof editingValue["paramValue"] === "string" ? editingValue["paramValue"] : undefined} />
                      </div>
                      <LineMatchFields defaultOnlyMatchedLines={defaultOnlyMatchedLines} defaultRejectUnmatchedLines={defaultRejectUnmatchedLines} />
                      <p className="b-help">The storefront runtime evaluates the current browser URL. Shopify Functions cannot read a browser URL directly.</p>
                    </div>
                  )}

                  {selectedType === "utm_parameters" && (
                    <div className="b-stack b-stack-3">
                      <div>
                        <label className="b-label" htmlFor="utmSource">UTM Source</label>
                        <input id="utmSource" name="utmSource" className="b-input" placeholder="amazon" autoComplete="off" defaultValue={typeof editingValue["utmSource"] === "string" ? editingValue["utmSource"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="utmMedium">UTM Medium</label>
                        <input id="utmMedium" name="utmMedium" className="b-input" placeholder="cpc" autoComplete="off" defaultValue={typeof editingValue["utmMedium"] === "string" ? editingValue["utmMedium"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="utmCampaign">UTM Campaign</label>
                        <input id="utmCampaign" name="utmCampaign" className="b-input" placeholder="primeday2026" autoComplete="off" defaultValue={typeof editingValue["utmCampaign"] === "string" ? editingValue["utmCampaign"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="utmTerm">UTM Term</label>
                        <input id="utmTerm" name="utmTerm" className="b-input" placeholder="running-shoes" autoComplete="off" defaultValue={typeof editingValue["utmTerm"] === "string" ? editingValue["utmTerm"] : undefined} />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="utmContent">UTM Content</label>
                        <input id="utmContent" name="utmContent" className="b-input" placeholder="banner-a" autoComplete="off" defaultValue={typeof editingValue["utmContent"] === "string" ? editingValue["utmContent"] : undefined} />
                      </div>
                      <UtmScopeChoice name="utmScope" defaultValue={editingValue["scope"] === "visit" ? "visit" : "page"} />
                      <LineMatchFields defaultOnlyMatchedLines={defaultOnlyMatchedLines} defaultRejectUnmatchedLines={defaultRejectUnmatchedLines} />
                      <div className="b-banner b-banner-blue" role="status">
                        <div className="b-banner-body" style={{ width: "100%" }}>
                          <p className="b-banner-title">What this does</p>
                          <p className="b-banner-text">
                            UTM parameters are the tags marketers add to a link (like
                            <code> ?utm_source=amazon</code>) to track where traffic came from. This
                            condition only lets the offer apply if the customer's original landing URL
                            carried the values you fill in below — for example, set UTM Source to
                            "amazon-primeday" to gate an offer to customers who clicked through from that
                            campaign.
                          </p>
                          <p className="b-banner-text" style={{ marginTop: 8 }}>
                            <strong>No setup required:</strong> these values are captured automatically
                            from the customer's landing page on every visit — unlike the
                            <code> __landing_source</code> line property elsewhere in this app, there's no
                            snippet to add to a landing page.
                          </p>
                          <p className="b-banner-text" style={{ marginTop: 8 }}>
                            <strong>Combining it:</strong> add another main or sub-condition below — every
                            enabled condition on this offer applies together (AND). Leave a field blank to
                            skip checking that parameter — only the fields you fill in are required to
                            match.
                          </p>
                        </div>
                      </div>
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
                        {isSubmitting ? (editingId ? "Saving…" : "Adding…") : editingId ? "Save Changes" : "Add Condition"}
                      </button>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary"
                        onClick={closeConditionForm}
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

      <ConfirmDialog
        open={confirmDeleteConditionId !== null}
        ariaLabel="Remove condition"
        title="Remove this condition?"
        message="Remove this condition?"
        confirmLabel="Remove"
        onConfirm={() => {
          if (!confirmDeleteConditionId) return;
          const fd = new FormData();
          fd.append("intent", "delete_condition");
          fd.append("conditionId", confirmDeleteConditionId);
          void submit(fd, { method: "POST" });
          setConfirmDeleteConditionId(null);
        }}
        onCancel={() => setConfirmDeleteConditionId(null)}
      />
    </>
  );
}
