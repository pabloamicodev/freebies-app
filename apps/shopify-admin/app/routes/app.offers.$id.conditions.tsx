/**
 * Offer Conditions Editor — Step 2-3 of the offer builder wizard.
 * Allows adding/editing main conditions and subconditions with a
 * validated form for each condition type.
 */

import { useRef, useState } from "react";
import { parseUuidParam } from "../lib/route-params.js";
import { useLoaderData, Form, Link, useActionData, useNavigation, useSubmit } from "react-router";
import * as Sentry from "@sentry/node";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { SelectedProductsList, type SelectedProduct } from "../components/SelectedProductsList.js";
import { MatchBySelect, MatchRuleField, ProductConditionNote, pickedItems } from "../components/ProductConditionFields.js";
import { readMatchBy, readMatchRule, requirementGids, type MatchBy, type MatchRule } from "../lib/product-condition.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { formatStoredAmount, isZeroDecimalCurrency } from "../lib/money.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { discountCodes, offerConditions } from "@promo/db";
import {
  CART_ATTRIBUTE_KEYS,
  ConditionTypeSchema,
  LINE_ATTRIBUTE_KEYS,
  resolveOnlyMatchedLines,
  resolveRejectUnmatchedLines,
  type ConditionScope,
} from "@promo/shared-types";
import {
  OnlyMatchedLinesCheckbox,
  PAGE_TYPES_HELP,
  PageTypeCheckboxes,
  RejectUnmatchedLinesCheckbox,
  UtmScopeChoice,
} from "../components/subconditions/forms.js";
import { DEFAULT_CODE_PAGE_TYPES, readExcludeUrls, readPageTypes, readPageUrls } from "../lib/page-types.js";
import { ExperimentForm, SectionShownForm, TemplateForm } from "../components/subconditions/forms.js";
import { and, eq } from "drizzle-orm";
import { addCondition, deleteCondition, updateCondition, type ConditionFailure, type ConditionInput } from "../lib/offer-conditions.server.js";
import { getMarketsForShop } from "../lib/markets.server.js";
import { isCheckoutCodeGated } from "../lib/code-redemption.js";
import { conditionSummary, conditionTypeLabel } from "../lib/offer-summaries.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { CapacityLimitModal } from "../components/CapacityLimitModal.js";
import { withCapacityModal } from "../lib/capacity-capture.server.js";

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
  const { shopId, db, currencyCode: shopCurrencyCode } = await getShopContext(request);
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
    shopCurrency: shopCurrencyCode.toUpperCase(),
    conditions: conditionRows.sort((a, b) => a.sortOrder - b.sortOrder),
    markets,
    isCodePromo: isCheckoutCodeGated(offer, Boolean(firstCode)),
  };
};

/** FormData -> typed service input. Numbers keep the form's parse (NaN included) so the service reports the same messages. */
function formToCondition(conditionType: string, formData: FormData): ConditionInput | { error: string } {
  const str = (name: string) => formData.get(name) as string | null;
  switch (conditionType) {
    case "cart_value":
      return { type: conditionType, threshold: parseFloat(str("threshold") as string), currencyCode: String(formData.get("currencyCode") || "") || undefined, includeGiftValues: formData.get("includeGiftValues") === "on" };
    case "cart_quantity": {
      const maxQtyRaw = formData.get("maxQty");
      return { type: conditionType, minQuantity: parseInt(str("minQty") as string, 10), maxQuantity: maxQtyRaw ? parseInt(maxQtyRaw as string, 10) : undefined };
    }
    case "cart_value_multiplier": {
      const multRaw = formData.get("maxMultiplier");
      return { type: conditionType, threshold: parseFloat(str("threshold") as string), maxMultiplier: multRaw ? parseInt(multRaw as string, 10) : undefined, currencyCode: String(formData.get("currencyCode") || "") || undefined };
    }
    case "customer_tags":
      return { type: conditionType, includeTags: splitCsvList(str("includeTags")), excludeTags: splitCsvList(str("excludeTags")), treatGuestAsNoTags: formData.get("treatGuestAsNoTags") === "on" };
    case "order_history_total_spent":
    case "order_history_last_order_spent":
    case "order_history_total_orders":
      return { type: conditionType, value: parseFloat(str("orderValue") as string), operator: String(formData.get("operator") ?? "gte") };
    case "one_use_per_customer":
      return { type: conditionType };
    case "markets":
      return { type: conditionType, includeMarketIds: splitCsvList(str("includeMarkets")), excludeMarketIds: splitCsvList(str("excludeMarkets")) };
    case "customer_location":
      return { type: conditionType, includeCountryCodes: splitCountryCsv(str("includeCountries")), excludeCountryCodes: splitCountryCsv(str("excludeCountries")) };
    case "sales_channels":
      return { type: conditionType, channels: formData.getAll("channels[]") as string[] };
    case "subscription_product_type":
      return { type: conditionType, mode: str("subscriptionMode") ?? undefined };
    case "specific_link":
      return {
        type: conditionType,
        requiredUrl: String(formData.get("requiredUrl") ?? ""),
        paramName: String(formData.get("paramName") ?? ""),
        paramValue: String(formData.get("paramValue") ?? ""),
        ...lineMatchFlags(formData),
      };
    case "page_types":
      return { type: conditionType, pageTypes: formData.getAll("pageTypes").map(String), pageUrls: formData.getAll("pageUrls"), excludeUrls: formData.getAll("excludeUrls"), ...lineMatchFlags(formData) };
    case "template":
    case "section_shown":
    case "experiment": {
      let raw: unknown = {};
      try {
        raw = JSON.parse(String(formData.get("pageStampValue") ?? "{}"));
      } catch {
        return { error: "Condition value is invalid." };
      }
      return { ...(raw && typeof raw === "object" ? raw : {}), type: conditionType };
    }
    case "page_url":
      return { type: conditionType, patterns: splitCsvList(str("urlPatterns")), matchMode: str("matchMode") ?? "starts_with", ...lineMatchFlags(formData) };
    case "specific_product":
    case "pack_of_products": {
      const matchBy: MatchBy = formData.get("matchBy") === "product" ? "product" : "variant";
      return {
        type: conditionType,
        matchBy,
        ids: splitCsvList(str(matchBy === "product" ? "requiredProductGids" : "requiredVariantGids")),
        matchRule: formData.get("matchRule") === "any" ? "any" : "all",
        minQuantityPerProduct: parseInt(str("minQtyPerProduct") ?? "1", 10),
      };
    }
    case "line_attribute":
      return {
        type: conditionType,
        key: String(formData.get("attributeKey") ?? ""),
        value: String(formData.get("attributeValue") ?? ""),
        matchMode: formData.get("attributeMatchMode") === "not_equals" ? "not_equals" : "equals",
        minMatchingQuantity: parseInt(String(formData.get("attributeMinQuantity") ?? "1"), 10),
      };
    case "cart_attribute":
      return { type: conditionType, key: String(formData.get("attributeKey") ?? ""), value: String(formData.get("attributeValue") ?? ""), matchMode: formData.get("attributeMatchMode") === "not_equals" ? "not_equals" : "equals" };
    case "discount_code":
      return { type: conditionType };
    case "utm_parameters":
      return {
        type: conditionType,
        utmSource: String(formData.get("utmSource") ?? ""),
        utmMedium: String(formData.get("utmMedium") ?? ""),
        utmCampaign: String(formData.get("utmCampaign") ?? ""),
        utmTerm: String(formData.get("utmTerm") ?? ""),
        utmContent: String(formData.get("utmContent") ?? ""),
        scope: formData.get("utmScope") === "visit" ? "visit" : "page",
        ...lineMatchFlags(formData),
      };
    default:
      return { type: conditionType } as ConditionInput;
  }
}

export const action = withCapacityModal(async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db, currencyCode: shopCurrencyCode, timezone } = await getShopContext(request);
  const offerId = parseUuidParam(params);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  await loadOwnedOffer(db, shopId, offerId);
  const deps = { db, shopId, shopDomain: session.shop, shopCurrency: shopCurrencyCode, timezone };
  const opts = {
    performedBy: session.shop,
    acknowledgeWarnings: formData.get("acknowledgeWarnings") === "1",
    warningAuth: { shopDomain: session.shop, accessToken: session.accessToken ?? "" },
  };
  // A condition that vanished meanwhile (double click) was a silent no-op before the service existed.
  const outcome = (result: { ok: true } | ConditionFailure) => {
    if (result.ok || result.code === "condition_not_found") return null;
    return result.code === "warnings" ? { warnings: result.warnings } : { error: result.error };
  };

  if (intent === "add_condition" || intent === "update_condition") {
    const conditionType = formData.get("conditionType") as string;
    const conditionTypeResult = ConditionTypeSchema.safeParse(conditionType);
    if (!conditionTypeResult.success) return { error: "Condition type is invalid." };
    const scope: ConditionScope = formData.get("scope") === "sub" ? "sub" : "main";
    const condition = formToCondition(conditionType, formData);
    if ("error" in condition) return { error: condition.error };

    const conditionId = intent === "update_condition" ? (formData.get("conditionId") as string | null) ?? "" : "";
    const failed = outcome(
      intent === "add_condition"
        ? await addCondition(deps, { offerId, scope, condition }, opts)
        : await updateCondition(deps, { offerId, scope, condition, conditionId }, opts),
    );
    if (failed) return failed;
  }

  if (intent === "delete_condition") {
    const failed = outcome(await deleteCondition(deps, { offerId, conditionId: formData.get("conditionId") as string }, { performedBy: session.shop }));
    if (failed) return failed;
  }

  return { success: true };
});

const MAIN_CONDITION_TYPES = [
  { label: "Cart Value — spend threshold", value: "cart_value" },
  { label: "Cart Quantity — item count threshold", value: "cart_quantity" },
  { label: "Cart Value Multiplier — earn gifts per $ spent", value: "cart_value_multiplier" },
  { label: "Specific Product — any of / all of the selected variants or products", value: "specific_product" },
  { label: "Pack of Products — every product in the pack must be present", value: "pack_of_products" },
  { label: "Page URL — restrict to specific storefront pages", value: "page_url" },
  { label: "Store pages — products added from home, collections, product pages…", value: "page_types" },
  { label: "Template — visitor saw one of these templates", value: "template" },
  { label: "Section is shown — visitor saw one of these sections", value: "section_shown" },
  { label: "Test group — visitor is in one of these arms", value: "experiment" },
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
  { label: "Template", value: "template" },
  { label: "Section is shown", value: "section_shown" },
  { label: "Test group", value: "experiment" },
];

/** Pulls the edit-form-relevant fields out of a condition's stored value —
 * shared by startEditCondition and the initial state below, so the first
 * condition can open pre-filled exactly like a real click would produce. */
function deriveConditionEditFields(value: Record<string, unknown>, operator: string | undefined, shopCurrency: string) {
  const currencyCode = typeof value["currencyCode"] === "string" ? (value["currencyCode"] as string) : shopCurrency;
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
  return { currencyCode, includeMarketIds, excludeMarketIds, requiredVariantGids, requiredProductGids, matchBy, matchRule: readMatchRule(operator), minQtyPerProduct };
}

export default function OfferConditionsPage() {
  const { offer, shopCurrency, conditions, markets, isCodePromo } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const lastForm = useRef<FormData | null>(null);
  const [dismissed, setDismissed] = useState<unknown>(null);
  const isSubmitting = navigation.state !== "idle";
  const [conditionState, setConditionField] = useObjectState(() => {
    // Open the first condition's edit form by default, so it's immediately
    // obvious these rows are clickable and what clicking one reveals —
    // instead of a wall of collapsed summaries with no visible affordance.
    const first = conditions[0];
    const fields = first ? deriveConditionEditFields((first.value ?? {}) as Record<string, unknown>, first.operator, shopCurrency) : null;
    return {
      addingScope: (first?.scope as "main" | "sub" | undefined) ?? null,
      editingId: first?.id ?? null,
      selectedType: first?.conditionType ?? "",
      pickerOpen: false,
      pickerTarget: "required" as "required" | "exclude" | "gift",
      requiredVariantGids: fields?.requiredVariantGids ?? [],
      requiredProductGids: fields?.requiredProductGids ?? [],
      matchBy: (fields?.matchBy ?? "variant") as MatchBy,
      matchRule: (fields?.matchRule ?? "any") as MatchRule,
      pickedProducts: [] as SelectedProduct[],
      excludeVariantGids: [] as string[],
      currencyCode: fields?.currencyCode ?? shopCurrency,
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
    matchRule,
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
  const setMatchRule = createFieldSetter(setConditionField, "matchRule");
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
    const fields = deriveConditionEditFields(value, c.operator, shopCurrency);
    setAddingScope(c.scope as "main" | "sub");
    setSelectedType(c.conditionType);
    setEditingId(c.id);
    setCurrencyCode(fields.currencyCode);
    setIncludeMarketIds(fields.includeMarketIds);
    setExcludeMarketIds(fields.excludeMarketIds);
    setRequiredVariantGids(fields.requiredVariantGids);
    setRequiredProductGids(fields.requiredProductGids);
    setMatchBy(fields.matchBy);
    setMatchRule(fields.matchRule);
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

      <ConfirmDialog
        open={Boolean(actionData && "warnings" in actionData && actionData.warnings?.length) && dismissed !== actionData}
        ariaLabel="Publish warnings"
        title="Publish anyway?"
        message={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {actionData && "warnings" in actionData && actionData.warnings?.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        }
        confirmLabel="Publish anyway"
        destructive={false}
        onConfirm={() => {
          setDismissed(actionData);
          if (!lastForm.current) return;
          lastForm.current.set("acknowledgeWarnings", "1");
          void submit(lastForm.current, { method: "POST" });
        }}
        onCancel={() => setDismissed(actionData)}
      />

      <div className="b-page">
        <CapacityLimitModal data={actionData?.capacity} />
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
                        {conditionSummary(c.conditionType, c.value, c.operator, shopCurrency)}
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
                  onClick={() => { setEditingId(null); setAddingScope("main"); setSelectedType(""); setMatchRule("any"); }}
                >
                  + Add Main Condition
                </button>
                <button
                  type="button"
                  className="b-btn b-btn-secondary"
                  onClick={() => { setEditingId(null); setAddingScope("sub"); setSelectedType(""); setMatchRule("all"); }}
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
              <Form method="POST" key={editingId ?? "new"} onSubmit={(e) => { lastForm.current = new FormData(e.currentTarget); }}>
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
                          step={isZeroDecimalCurrency(shopCurrency) ? "1" : "0.01"}
                          required
                          autoComplete="off"
                          defaultValue={typeof editingValue["thresholdCents"] === "number" ? formatStoredAmount(editingValue["thresholdCents"], shopCurrency) : undefined}
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
                      {selectedType === "specific_product" && (
                        <MatchRuleField name="matchRule" value={matchRule} onChange={setMatchRule} />
                      )}
                      {!(selectedType === "specific_product" && matchRule === "any") && (
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
                      )}
                      <ProductConditionNote
                        type={selectedType as "specific_product" | "pack_of_products"}
                        matchBy={matchBy}
                        minQty={parseInt(minQtyPerProduct, 10) || 1}
                        rule={matchRule}
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

                  {(selectedType === "template" || selectedType === "section_shown" || selectedType === "experiment") && (
                    <PageStampFields
                      key={selectedType}
                      conditionType={selectedType}
                      initial={editingCondition?.conditionType === selectedType ? editingValue : undefined}
                      isCodePromo={isCodePromo}
                    />
                  )}

                  {selectedType === "page_types" && (
                    <fieldset className="b-stack b-stack-3" style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend className="b-label">Products count when added to the cart from</legend>
                      <PageTypeCheckboxes idPrefix="condition" name="pageTypes" selected={editingPageTypes} urls={readPageUrls(editingValue["pageUrls"])} urlsName="pageUrls" excludeUrls={readExcludeUrls(editingValue["excludeUrls"])} excludeUrlsName="excludeUrls" />
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
                        step={selectedType === "order_history_total_orders" || isZeroDecimalCurrency(shopCurrency) ? "1" : "0.01"}
                        required
                        defaultValue={
                          typeof editingValue["value"] === "number"
                            ? editingValue["value"]
                            : typeof editingValue["valueCents"] === "number"
                              ? formatStoredAmount(editingValue["valueCents"], shopCurrency)
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
                      can't be spoofed from the browser. Guests who type an email Shopify already knows are
                      recognised and checked like any customer; a guest with a brand-new email has no history and fails.
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
                      No fields to set — this simply limits each customer to one
                      redemption of this offer, checked against their real order history at
                      checkout. Guests who type an email Shopify already knows are recognised; a guest with a brand-new email has no history and fails.
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

/** Template / section / test-group editor for the plain-form editor: the value travels as one JSON field. */
function PageStampFields({
  conditionType,
  initial,
  isCodePromo,
}: {
  conditionType: "template" | "section_shown" | "experiment";
  initial?: Record<string, unknown>;
  isCodePromo: boolean;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initial ?? {});
  const Sub = conditionType === "template" ? TemplateForm : conditionType === "section_shown" ? SectionShownForm : ExperimentForm;
  return (
    <>
      <input type="hidden" name="pageStampValue" value={JSON.stringify(value)} />
      <Sub value={value} onChange={setValue} isCodePromo={isCodePromo} />
    </>
  );
}
