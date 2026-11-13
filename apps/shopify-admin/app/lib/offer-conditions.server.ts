import { and, eq } from "drizzle-orm";
import { offerConditions, offers, type Db } from "@promo/db";
import {
  normalizeExcludedPageUrls,
  normalizeStorePageUrls,
  validateConditionValue,
  type ConditionOperator,
  type ConditionScope,
  type ConditionType,
} from "@promo/shared-types";
import { insertAuditLog } from "./audit-log.server.js";
import { anyOfConflictError } from "./any-of-guard.server.js";
import { lowestGiftTier } from "./gift-tiered-offer.server.js";
import { normalizeOfferSubconditions } from "./gift-subconditions.js";
import { formatStoredAmount, toStoredAmount } from "./money.js";
import { getNewPublishWarningsForEdit, republishIfActive, tryPublishShop, type ShopPublishFn } from "./offer-publish-flow.server.js";
import { buildProductConditionValue, matchRuleOperator, type MatchBy, type MatchRule } from "./product-condition.js";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";

/**
 * Typed service behind the offer conditions editor: the admin route (FormData adapter) and the MCP tools
 * (zod adapter) both call it, so both run the same value building, validation, guards and republish.
 * Money fields are in MAJOR units of the shop currency.
 */

type LineMatch = { onlyMatchedLines?: boolean; rejectUnmatchedLines?: boolean };
type OrderHistoryOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export type ConditionInput =
  | { type: "cart_value"; threshold: number; currencyCode?: string; includeGiftValues?: boolean }
  | { type: "cart_quantity"; minQuantity: number; maxQuantity?: number }
  | { type: "cart_value_multiplier"; threshold: number; maxMultiplier?: number; currencyCode?: string }
  | { type: "customer_tags"; includeTags?: string[]; excludeTags?: string[]; treatGuestAsNoTags?: boolean }
  | { type: "order_history_total_spent" | "order_history_last_order_spent" | "order_history_total_orders"; value: number; operator?: string }
  | { type: "one_use_per_customer" }
  | { type: "markets"; includeMarketIds?: string[]; excludeMarketIds?: string[] }
  | { type: "customer_location"; includeCountryCodes?: string[]; excludeCountryCodes?: string[] }
  | { type: "sales_channels"; channels: string[] }
  | { type: "subscription_product_type"; mode?: string }
  | ({ type: "specific_link"; requiredUrl: string; paramName?: string; paramValue?: string } & LineMatch)
  | ({ type: "page_types"; pageTypes: string[]; pageUrls?: unknown[]; excludeUrls?: unknown[] } & LineMatch)
  | { type: "template" | "section_shown" | "experiment"; [field: string]: unknown }
  | ({ type: "page_url"; patterns: string[]; matchMode?: string } & LineMatch)
  | { type: "specific_product" | "pack_of_products"; matchBy?: MatchBy; ids: string[]; matchRule?: MatchRule; minQuantityPerProduct?: number }
  | { type: "line_attribute"; key: string; value?: string; matchMode?: string; minMatchingQuantity?: number }
  | { type: "cart_attribute"; key: string; value?: string; matchMode?: string }
  | { type: "discount_code" }
  | ({ type: "utm_parameters"; utmSource?: string; utmMedium?: string; utmCampaign?: string; utmTerm?: string; utmContent?: string; scope?: string } & LineMatch);

export type BuiltCondition = { value: Record<string, unknown>; operator: ConditionOperator };
export type BuildResult = { ok: true; value: BuiltCondition } | { ok: false; error: string };

const fail = (error: string): BuildResult => ({ ok: false, error });
const flags = (c: LineMatch) => ({ onlyMatchedLines: c.onlyMatchedLines === true, rejectUnmatchedLines: c.rejectUnmatchedLines === true });
const trimmed = (v: unknown) => String(v ?? "").trim();
const list = (v: readonly string[] | undefined) => (v ?? []).flatMap((item) => (item.trim() ? [item.trim()] : []));
const countries = (v: readonly string[] | undefined) => (v ?? []).flatMap((item) => (item.trim() ? [item.trim().toUpperCase()] : []));
const attributeMode = (mode: unknown) => (mode === "not_equals" ? "not_equals" : "equals");

/** Builds and validates the stored `{ value, operator }` of one condition. The only place the per-type value shapes live. */
export function buildConditionValue(conditionType: string, input: ConditionInput | { type: string }, deps: Pick<AuthoringDeps, "shopCurrency">): BuildResult {
  const shopCurrency = deps.shopCurrency;
  const c = input as Record<string, unknown> & ConditionInput;
  let value: Record<string, unknown> = {};
  let operator: ConditionOperator = "gte";

  switch (conditionType) {
    case "cart_value": {
      const i = c as Extract<ConditionInput, { type: "cart_value" }>;
      if (!Number.isFinite(i.threshold) || i.threshold < 0) return fail("Threshold must be a valid positive number.");
      // The unit is the shop's, whatever tag is typed: a free-text "JPY" on a USD shop must not store whole units.
      value = {
        thresholdCents: toStoredAmount(i.threshold, shopCurrency),
        currencyCode: i.currencyCode || shopCurrency,
        includeGiftValues: i.includeGiftValues === true,
      };
      break;
    }
    case "cart_quantity": {
      const i = c as Extract<ConditionInput, { type: "cart_quantity" }>;
      if (!Number.isFinite(i.minQuantity) || i.minQuantity < 1) return fail("Minimum quantity must be at least 1.");
      value = {
        minQuantity: i.minQuantity,
        maxQuantity: i.maxQuantity !== undefined && Number.isFinite(i.maxQuantity) ? i.maxQuantity : undefined,
        includeGiftValues: false,
      };
      break;
    }
    case "cart_value_multiplier": {
      const i = c as Extract<ConditionInput, { type: "cart_value_multiplier" }>;
      if (!Number.isFinite(i.threshold) || i.threshold < 0) return fail("Threshold must be a valid positive number.");
      value = {
        thresholdCents: toStoredAmount(i.threshold, shopCurrency),
        currencyCode: i.currencyCode || shopCurrency,
        maxMultiplier: i.maxMultiplier !== undefined && Number.isFinite(i.maxMultiplier) ? i.maxMultiplier : undefined,
        includeGiftValues: false,
      };
      break;
    }
    case "customer_tags": {
      const i = c as Extract<ConditionInput, { type: "customer_tags" }>;
      value = { includeTags: list(i.includeTags), excludeTags: list(i.excludeTags), treatGuestAsNoTags: i.treatGuestAsNoTags === true };
      break;
    }
    case "order_history_total_spent":
    case "order_history_last_order_spent":
    case "order_history_total_orders": {
      const i = c as Extract<ConditionInput, { type: "order_history_total_orders" }>;
      if (!Number.isFinite(i.value) || i.value < 0) return fail("Order value must be a valid positive number.");
      operator = ["eq", "gt", "gte", "lt", "lte"].includes(String(i.operator ?? "gte")) ? ((i.operator ?? "gte") as OrderHistoryOperator) : "gte";
      const historyType =
        conditionType === "order_history_total_orders" ? "total_orders" : conditionType === "order_history_last_order_spent" ? "last_order_spent" : "total_spent";
      value = {
        type: historyType,
        operator,
        ...(historyType === "total_orders" ? { value: Math.floor(i.value) } : { valueCents: toStoredAmount(i.value, shopCurrency) }),
      };
      break;
    }
    case "one_use_per_customer":
      value = {};
      break;
    case "markets": {
      const i = c as Extract<ConditionInput, { type: "markets" }>;
      const includeMarketIds = list(i.includeMarketIds);
      const excludeMarketIds = list(i.excludeMarketIds);
      if (includeMarketIds.length === 0 && excludeMarketIds.length === 0) return fail("Select at least one Shopify Market.");
      value = { includeMarketIds, excludeMarketIds };
      break;
    }
    case "customer_location": {
      const i = c as Extract<ConditionInput, { type: "customer_location" }>;
      value = { includeCountryCodes: countries(i.includeCountryCodes), excludeCountryCodes: countries(i.excludeCountryCodes) };
      break;
    }
    case "sales_channels":
      value = { channels: [...((c as Extract<ConditionInput, { type: "sales_channels" }>).channels ?? [])] };
      break;
    case "subscription_product_type":
      value = { mode: (c as Extract<ConditionInput, { type: "subscription_product_type" }>).mode ?? "subscription_only" };
      break;
    case "specific_link": {
      const i = c as Extract<ConditionInput, { type: "specific_link" }>;
      const paramName = trimmed(i.paramName);
      const paramValue = String(i.paramValue ?? "");
      value = { requiredUrl: trimmed(i.requiredUrl), ...(paramName ? { paramName } : {}), ...(paramValue ? { paramValue } : {}), ...flags(i) };
      break;
    }
    case "page_types": {
      const i = c as Extract<ConditionInput, { type: "page_types" }>;
      const pageTypes = (i.pageTypes ?? []).map(String);
      if (pageTypes.length === 0) return fail("Select at least one kind of store page.");
      const pageUrls = pageTypes.includes("page") ? normalizeStorePageUrls(i.pageUrls ?? []) : [];
      const excludeUrls = normalizeExcludedPageUrls(i.excludeUrls ?? []);
      value = { pageTypes, ...(pageUrls.length ? { pageUrls } : {}), ...(excludeUrls.length ? { excludeUrls } : {}), ...flags(i) };
      break;
    }
    case "template":
    case "section_shown":
    case "experiment": {
      const { type: _type, ...raw } = c as Record<string, unknown>;
      const normalized = normalizeOfferSubconditions({ [conditionType]: raw });
      if (!normalized.success) return fail(normalized.error);
      value = normalized.data[0]?.value ?? {};
      operator = normalized.data[0]?.operator ?? operator;
      break;
    }
    case "page_url": {
      const i = c as Extract<ConditionInput, { type: "page_url" }>;
      const patterns = list(i.patterns);
      if (patterns.length === 0) return fail("Enter at least one URL pattern.");
      value = { patterns, matchMode: i.matchMode ?? "starts_with", caseSensitive: false, ...flags(i) };
      break;
    }
    case "specific_product":
    case "pack_of_products": {
      const i = c as Extract<ConditionInput, { type: "specific_product" }>;
      const matchBy: MatchBy = i.matchBy === "product" ? "product" : "variant";
      const gids = list(i.ids);
      // An empty requirement list would insert a condition that can never match.
      if (gids.length === 0) return fail("Select at least one product before adding this condition.");
      const rule: MatchRule = conditionType === "specific_product" && i.matchRule === "any" ? "any" : "all";
      // "any" is presence-only, so it never carries a min quantity.
      const minQty = rule === "any" ? 1 : Math.trunc(i.minQuantityPerProduct ?? 1) || 1;
      value = buildProductConditionValue(conditionType, matchBy, gids, minQty);
      operator = matchRuleOperator(rule);
      break;
    }
    case "line_attribute": {
      const i = c as Extract<ConditionInput, { type: "line_attribute" }>;
      value = {
        key: String(i.key ?? ""),
        value: trimmed(i.value),
        matchMode: attributeMode(i.matchMode),
        minMatchingQuantity: Math.max(1, Math.trunc(i.minMatchingQuantity ?? 1) || 1),
      };
      break;
    }
    case "cart_attribute": {
      const i = c as Extract<ConditionInput, { type: "cart_attribute" }>;
      value = { key: String(i.key ?? ""), ...(i.matchMode === "exists" ? { matchMode: "exists" } : { value: trimmed(i.value), matchMode: attributeMode(i.matchMode) }) };
      break;
    }
    case "discount_code":
      return fail("Discount codes are managed on the offer's Codes tab, not as a condition.");
    case "utm_parameters": {
      const i = c as Extract<ConditionInput, { type: "utm_parameters" }>;
      value = {
        utmSource: trimmed(i.utmSource),
        utmMedium: trimmed(i.utmMedium),
        utmCampaign: trimmed(i.utmCampaign),
        utmTerm: trimmed(i.utmTerm),
        utmContent: trimmed(i.utmContent),
        scope: i.scope === "visit" ? "visit" : "page",
        ...flags(i),
      };
      break;
    }
  }

  const valueResult = validateConditionValue(conditionType, value);
  if (!valueResult.success) return fail(valueResult.error.issues[0]?.message ?? "Condition value is invalid.");
  return { ok: true, value: { value, operator } };
}

export type ConditionWriteOptions = WriteServiceOptions & {
  /** Admin UI only: skip the advisory "new publish warnings" prompt (the operator already acknowledged them). */
  acknowledgeWarnings?: boolean;
  /** Admin UI only: the shop token the advisory warnings need. Without it no advisory lookup runs. */
  warningAuth?: { shopDomain: string; accessToken: string };
};

export type ConditionFailure =
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "condition_not_found"; error: string }
  | { ok: false; code: "validation"; error: string }
  | { ok: false; code: "stale"; error: string }
  | { ok: false; code: "warnings"; error: string; warnings: string[] }
  | { ok: false; code: "publish_failed"; error: string };

export type ConditionSuccess = { ok: true; dryRun: boolean; offerId: string; conditionId: string | null; scope: ConditionScope; conditionType: ConditionType; operator: ConditionOperator; value: Record<string, unknown>; published: boolean };
export type ConditionResult = ConditionSuccess | ConditionFailure;

const failure = (code: Exclude<ConditionFailure["code"], "warnings">, error: string): ConditionFailure => ({ ok: false, code, error });

type OfferRow = { id: string; status: string; updatedAt: Date };

async function loadOffer(db: Db, shopId: string, offerId: string): Promise<OfferRow | null> {
  const [row] = await db
    .select({ id: offers.id, status: offers.status, updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);
  return row ?? null;
}

const staleError = (offer: OfferRow, opts: WriteServiceOptions) =>
  opts.expectedUpdatedAt && opts.expectedUpdatedAt.getTime() !== offer.updatedAt.getTime()
    ? failure("stale", "The offer changed since it was read; read it again.")
    : null;

async function audit(deps: AuthoringDeps, opts: WriteServiceOptions, offerId: string, action: string, after: Record<string, unknown>, before?: unknown) {
  await insertAuditLog(deps.db, {
    shopId: deps.shopId,
    entityType: "offer",
    entityId: offerId,
    action,
    before,
    after: { ...after, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });
}

async function republish(deps: AuthoringDeps, opts: WriteServiceOptions, offerId: string, offer: OfferRow): Promise<ConditionFailure | null> {
  const publish: ShopPublishFn = opts.publish ?? tryPublishShop;
  const publishError = await republishIfActive(deps.db, deps.shopId, deps.shopDomain, offerId, offer.status === "active", publish);
  return publishError ? failure("publish_failed", publishError) : null;
}

type UpsertInput = { offerId: string; scope?: ConditionScope; condition: ConditionInput; conditionId?: string };

async function upsert(deps: AuthoringDeps, mode: "add" | "update", input: UpsertInput, opts: ConditionWriteOptions): Promise<ConditionResult> {
  const { db, shopId } = deps;
  const { offerId, condition } = input;
  const scope: ConditionScope = input.scope ?? "main";
  const conditionType = condition.type;
  const offer = await loadOffer(db, shopId, offerId);
  if (!offer) return failure("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;

  const built = buildConditionValue(conditionType, condition, deps);
  if (!built.ok) return failure("validation", built.error);
  const { value, operator } = built.value;

  if (scope === "main" && conditionType === "cart_value" && typeof (value as { thresholdCents?: unknown }).thresholdCents === "number") {
    const lowestTier = await lowestGiftTier(db, shopId, offerId);
    if (lowestTier !== null && (value as { thresholdCents: number }).thresholdCents > lowestTier) {
      return failure(
        "validation",
        `The minimum cart value cannot be above this offer's lowest gift tier (${formatStoredAmount(lowestTier, deps.shopCurrency)}), or that tier could never unlock. Lower it, or raise the tier on the rewards page.`,
      );
    }
  }
  if (conditionType === "specific_product" && operator === "any") {
    const conflict = await anyOfConflictError(db, shopId, offerId, mode === "update" ? input.conditionId : undefined);
    if (conflict) return failure("validation", conflict);
  }
  if (mode === "update" && !input.conditionId) return failure("validation", "Condition ID missing.");

  if ((offer.status === "active" || offer.status === "scheduled") && !opts.acknowledgeWarnings && opts.warningAuth && !opts.dryRun) {
    const warnings = await getNewPublishWarningsForEdit(db, shopId, offerId, opts.warningAuth, { conditionId: input.conditionId, conditionType, value });
    if (warnings.length > 0) return { ok: false, code: "warnings", error: "Publish warnings need acknowledging.", warnings };
  }

  const result = (conditionId: string | null, published: boolean): ConditionSuccess => ({
    ok: true,
    dryRun: opts.dryRun === true,
    offerId,
    conditionId,
    scope,
    conditionType,
    operator,
    value,
    published,
  });

  if (mode === "update") {
    const [existing] = await db
      .select({ id: offerConditions.id })
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, input.conditionId!)))
      .limit(1);
    if (!existing) return failure("condition_not_found", "Condition not found on this offer.");
  }
  if (opts.dryRun) return result(input.conditionId ?? null, false);

  let conditionId: string | null = input.conditionId ?? null;
  if (mode === "add") {
    const existingCount = await db
      .select({ id: offerConditions.id })
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
    const [inserted] = await db
      .insert(offerConditions)
      .values({ shopId, offerId, scope, conditionType, operator, value, sortOrder: existingCount.length, isEnabled: true })
      .returning({ id: offerConditions.id });
    conditionId = inserted?.id ?? null;
  } else {
    await db
      .update(offerConditions)
      .set({ scope, conditionType, operator, value })
      .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, input.conditionId!)));
  }
  await audit(deps, opts, offerId, mode === "add" ? "condition_added" : "condition_updated", { conditionId, scope, conditionType, operator, value });
  const publishFailure = await republish(deps, opts, offerId, offer);
  if (publishFailure) return publishFailure;
  return result(conditionId, offer.status === "active");
}

export const addCondition = (deps: AuthoringDeps, input: Omit<UpsertInput, "conditionId">, opts: ConditionWriteOptions) => upsert(deps, "add", input, opts);
export const updateCondition = (deps: AuthoringDeps, input: UpsertInput & { conditionId: string }, opts: ConditionWriteOptions) => upsert(deps, "update", input, opts);

export async function deleteCondition(
  deps: AuthoringDeps,
  input: { offerId: string; conditionId: string },
  opts: WriteServiceOptions,
): Promise<{ ok: true; dryRun: boolean; offerId: string; conditionId: string; published: boolean } | ConditionFailure> {
  const { db, shopId } = deps;
  const { offerId, conditionId } = input;
  const offer = await loadOffer(db, shopId, offerId);
  if (!offer) return failure("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;

  const byOffer = and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId));
  if (offer.status === "active") {
    const [conditionToDelete, mainConditions] = await Promise.all([
      db.select({ scope: offerConditions.scope, isEnabled: offerConditions.isEnabled }).from(offerConditions).where(and(byOffer, eq(offerConditions.id, conditionId))).limit(1),
      db.select({ id: offerConditions.id }).from(offerConditions).where(and(byOffer, eq(offerConditions.scope, "main"), eq(offerConditions.isEnabled, true))),
    ]);
    if (conditionToDelete[0]?.scope === "main" && conditionToDelete[0].isEnabled && mainConditions.length <= 1) {
      return failure("validation", "Cannot delete the last enabled main condition from an active offer. Pause it first or add another main condition.");
    }
  }
  const [target] = await db.select({ id: offerConditions.id, conditionType: offerConditions.conditionType, scope: offerConditions.scope, value: offerConditions.value }).from(offerConditions).where(and(byOffer, eq(offerConditions.id, conditionId))).limit(1);
  if (!target) return failure("condition_not_found", "Condition not found on this offer.");
  if (opts.dryRun) return { ok: true, dryRun: true, offerId, conditionId, published: false };

  await db.delete(offerConditions).where(and(byOffer, eq(offerConditions.id, conditionId)));
  await audit(deps, opts, offerId, "condition_deleted", { conditionId }, { conditionType: target.conditionType, scope: target.scope, value: target.value });
  const publishFailure = await republish(deps, opts, offerId, offer);
  if (publishFailure) return publishFailure;
  return { ok: true, dryRun: false, offerId, conditionId, published: offer.status === "active" };
}

/** Replaces the whole set of sub-conditions (what the offer page's "save_subconditions" does); `subconditions` is the editor's keyed payload. */
export async function setSubconditions(
  deps: AuthoringDeps,
  input: { offerId: string } & (
    | { subconditions: Record<string, unknown> }
    /** Already built and validated (e.g. by toStoredConditions); stored as given. */
    | { conditions: Array<{ conditionType: ConditionType; operator: ConditionOperator; value: Record<string, unknown> }> }
  ),
  opts: WriteServiceOptions,
): Promise<{ ok: true; dryRun: boolean; offerId: string; conditions: Array<{ conditionType: ConditionType; operator: ConditionOperator; value: Record<string, unknown> }>; published: boolean } | ConditionFailure> {
  const { db, shopId } = deps;
  const { offerId } = input;
  const offer = await loadOffer(db, shopId, offerId);
  if (!offer) return failure("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;

  let conditions: Array<{ conditionType: ConditionType; operator: ConditionOperator; value: Record<string, unknown> }>;
  if ("conditions" in input) {
    conditions = input.conditions;
  } else {
    const normalized = normalizeOfferSubconditions(input.subconditions, deps.shopCurrency);
    if (!normalized.success) return failure("validation", normalized.error);
    conditions = normalized.data;
  }
  if (opts.dryRun) return { ok: true, dryRun: true, offerId, conditions, published: false };

  // Replace atomically: a partial write would silently drop conditions if it failed midway.
  await db.transaction(async (tx) => {
    await tx.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "sub")));
    if (conditions.length > 0) {
      await tx.insert(offerConditions).values(
        conditions.map((c, index) => ({ shopId, offerId, scope: "sub" as const, conditionType: c.conditionType, operator: c.operator, value: c.value, sortOrder: index, isEnabled: true })),
      );
    }
  });
  await audit(deps, opts, offerId, "subconditions_replaced", { conditions });
  const publishFailure = await republish(deps, opts, offerId, offer);
  if (publishFailure) return publishFailure;
  return { ok: true, dryRun: false, offerId, conditions, published: offer.status === "active" };
}
