import { useLoaderData, useNavigate, useFetcher, useActionData, redirect, Link } from "react-router";
import { useState } from "react";
import { SUPPORTED_CURRENCIES, validateConditionValue, validateRewardPayload, ConditionTypeSchema, ConditionScopeSchema, resolveOnlyMatchedLines } from "@promo/shared-types";
import { getShopContext } from "../lib/shop-context.server.js";
import { insertAuditLog } from "../lib/audit-log.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { parseJsonRecord, parseJsonStringArray, parseDateRange } from "../lib/offer-validation.server.js";
import { normalizeConditionValue } from "../lib/offer-config-normalization.server.js";
import { publishShopConfig, republishIfActive, validateOffersPublishable } from "../lib/offer-publish-flow.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, offerVersions, discountCodes } from "@promo/db";
import { and, eq, desc, sql } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  IconChevronLeft, IconChevronRight, IconChevronDown, IconInfo, IconRefresh,
  IconPlus, IconCheck, IconLink, IconCondition,
} from "../components/Icons.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { OfferStepTabs } from "../components/OfferStepTabs.js";
import { SelectedProductsList } from "../components/SelectedProductsList.js";
import { SubconditionModal } from "../components/SubconditionModal.js";
import { SubconditionCard } from "../components/SubconditionCard.js";
import { SUB_FORMS } from "../components/subconditions/registry.js";
import { OnlyMatchedLinesCheckbox } from "../components/subconditions/forms.js";
import { GIFT_SUBCONDITIONS } from "../components/subconditions/types.js";
import type { SubconditionId } from "../components/subconditions/types.js";
import { normalizeOfferSubconditions } from "../lib/gift-subconditions.js";
import { getCodeNotices, offerRequiresCode } from "../lib/discount-codes.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, currencyCode: shopCurrencyCode, db } = await getShopContext(request);
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offer = await loadOwnedOffer(db, shopId, offerId);

  const [conditions, rewards, policy, [firstCode]] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
    db.select({ id: discountCodes.id }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId))).limit(1),
  ]);

  return {
    offer: {
      ...offer,
      startsAt: offer.startsAt?.toISOString() ?? null,
      endsAt: offer.endsAt?.toISOString() ?? null,
      createdAt: offer.createdAt.toISOString(),
      updatedAt: offer.updatedAt.toISOString(),
    },
    conditions: conditions.map((c) => ({
      ...c,
      value: c.value as Record<string, unknown>,
    })),
    rewards,
    policy: policy[0] ?? null,
    shopCurrencyCode,
    isCodePromo: Boolean(firstCode) || Boolean(offer.requiredDiscountCode) || offer.requiresCode,
    codeNotices: await getCodeNotices(db, shopId, offer),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { session, shopId, currencyCode: shopCurrencyCode, db } = context;
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });
  const intent = formData.get("intent") as string;
  const offer = await loadOwnedOffer(db, shopId, offerId);
  switch (intent) {
    case "update": {
      const publicTitle = formData.get("publicTitle") as string;
      const internalName = formData.get("internalName") as string;
      const dateResult = parseDateRange(formData, offer.timezone ?? "UTC");
      if (dateResult.error) return { error: dateResult.error };
      await db.update(offers).set({
        publicTitle, internalName,
        startsAt: dateResult.data!.startsAt,
        endsAt: dateResult.data!.endsAt,
        updatedAt: new Date(),
      }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
      if (publishError) return { error: publishError };
      void insertAuditLog(db, { shopId, entityType: "offer", entityId: offerId, action: "update", before: { publicTitle: offer.publicTitle, internalName: offer.internalName, startsAt: offer.startsAt, endsAt: offer.endsAt }, after: { publicTitle, internalName, startsAt: dateResult.data!.startsAt, endsAt: dateResult.data!.endsAt }, performedBy: session.shop });
      break;
    }
    case "update_condition": {
      const conditionId = formData.get("conditionId") as string;
      const valueResult = parseJsonRecord(formData, "conditionValue");
      if (valueResult.error) return { error: valueResult.error };
      const [condition] = await db.select({ conditionType: offerConditions.conditionType })
        .from(offerConditions)
        .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)))
        .limit(1);
      if (!condition) return { error: "Condition not found." };
      const value = normalizeConditionValue(condition.conditionType, valueResult.data!);
      if (offer.status === "active") {
        const parsedValue = validateConditionValue(condition.conditionType, value);
        if (!parsedValue.success) return { error: parsedValue.error.issues[0]?.message ?? "Condition value is invalid." };
      }
      await db.update(offerConditions).set({ value }).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, conditionId)));
      const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
      if (publishError) return { error: publishError };
      break;
    }
    case "delete_condition": {
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
      break;
    }
    case "add_condition": {
      const conditionTypeResult = ConditionTypeSchema.safeParse(formData.get("conditionType"));
      if (!conditionTypeResult.success) return { error: "Condition type is invalid." };
      const conditionType = conditionTypeResult.data;
      if (conditionType === "discount_code") return { error: "Discount codes are managed on the offer's Codes tab, not as a condition." };
      const scopeResult = ConditionScopeSchema.safeParse(formData.get("scope") ?? "main");
      if (!scopeResult.success) return { error: "Condition scope is invalid." };
      const scope = scopeResult.data;
      const valueResult = parseJsonRecord(formData, "conditionValue");
      if (valueResult.error) return { error: valueResult.error };
      const value = normalizeConditionValue(conditionType, valueResult.data!);
      if (offer.status === "active") {
        const parsedValue = validateConditionValue(conditionType, value);
        if (!parsedValue.success) return { error: parsedValue.error.issues[0]?.message ?? "Condition value is invalid." };
      }
      const existing = await db.select({ id: offerConditions.id }).from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
      await db.insert(offerConditions).values({
        shopId, offerId, scope, conditionType,
        operator: "gte", value, sortOrder: existing.length, isEnabled: true,
      });
      if (offer.status === "active") {
        const publishError = await publishShopConfig(shopId, session.shop);
        if (publishError) return { error: publishError };
      }
      break;
    }
    case "update_reward": {
      const rewardId = formData.get("rewardId") as string;
      if (!rewardId) return { error: "Missing reward id" };
      const quantityParsed = parseInt(formData.get("quantity") as string, 10);
      const quantity = Number.isFinite(quantityParsed) && quantityParsed >= 1 ? quantityParsed : 1;
      const discountType = formData.get("discountType") as string;
      const parsedValue = parseFloat(formData.get("discountValue") as string);
      const discountValue = Number.isFinite(parsedValue) ? parsedValue : 100;
      const isAutoAdd = formData.get("isAutoAdd") === "on";

      // Optional product target — variant GIDs from the picker. Only update
      // `target` when the field is present so plain discount edits don't wipe it.
      const targetRaw = formData.get("targetVariantIds");
      const set: Record<string, unknown> = {
        discountType: discountType as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
        value: { amount: discountValue, currencyCode: shopCurrencyCode },
        quantity,
        isAutoAdd,
      };
      if (typeof targetRaw === "string") {
        const targetForm = new FormData();
        targetForm.set("targetVariantIds", targetRaw);
        const variantIdsResult = parseJsonStringArray(targetForm, "targetVariantIds");
        if (variantIdsResult.error) return { error: variantIdsResult.error };
        const variantIds = variantIdsResult.data!;

        const fallbackRaw = formData.get("targetFallbackVariantIds");
        let fallbackVariantIds: string[] = [];
        if (typeof fallbackRaw === "string") {
          const fallbackForm = new FormData();
          fallbackForm.set("targetFallbackVariantIds", fallbackRaw);
          const fallbackResult = parseJsonStringArray(fallbackForm, "targetFallbackVariantIds");
          if (fallbackResult.error) return { error: fallbackResult.error };
          // A fallback that is also a primary gift would never act as a replacement.
          fallbackVariantIds = fallbackResult.data!.filter((id) => !variantIds.includes(id)).slice(0, 5);
        }
        set["target"] = { scope: "cart", variantIds, ...(fallbackVariantIds.length > 0 ? { fallbackVariantIds } : {}) };
      }
      if (offer.status === "active") {
        const [reward] = await db.select({ rewardType: offerRewards.rewardType, target: offerRewards.target })
          .from(offerRewards)
          .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, rewardId)))
          .limit(1);
        if (!reward) return { error: "Reward not found." };
        const rewardResult = validateRewardPayload(
          reward.rewardType,
          discountType,
          set["value"],
          set["target"] ?? reward.target,
        );
        if (!rewardResult.success) return { error: rewardResult.error.issues[0]?.message ?? "Reward configuration is invalid." };
      }
      await db.update(offerRewards).set(set).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, rewardId)));
      if (offer.status === "active") {
        const publishError = await publishShopConfig(shopId, session.shop);
        if (publishError) return { error: publishError };
      }
      break;
    }
    case "save_subconditions": {
      const subResult = parseJsonRecord(formData, "subconditions");
      if (subResult.error) return { error: subResult.error };
      const normalized = normalizeOfferSubconditions(subResult.data!);
      if (!normalized.success) return { error: normalized.error };

      // Replace every sub-condition atomically: this editor manages the whole
      // set as one unit (mirrors the offer-creation wizard), so a partial
      // write here would silently drop conditions if the request failed midway.
      await db.transaction(async (tx) => {
        await tx.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "sub")));
        if (normalized.data.length > 0) {
          await tx.insert(offerConditions).values(normalized.data.map((c, index) => ({
            shopId,
            offerId,
            scope: "sub" as const,
            conditionType: c.conditionType,
            operator: c.operator,
            value: c.value,
            sortOrder: index,
            isEnabled: true,
          })));
        }
      });
      if (offer.status === "active") {
        const publishError = await publishShopConfig(shopId, session.shop);
        if (publishError) return { error: publishError };
      }
      break;
    }
    case "publish": {
      // Guard: must have at least one scope='main' condition and one reward
      const [existingMainConditions, existingRewards] = await Promise.all([
        db.select({ id: offerConditions.id }).from(offerConditions)
          .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.scope, "main"))),
        db.select({ id: offerRewards.id }).from(offerRewards)
          .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
      ]);
      if (existingMainConditions.length === 0) {
        return { error: "Cannot publish: add at least one main condition before publishing." };
      }
      if (existingRewards.length === 0) {
        return { error: "Cannot publish: add at least one reward (gift) before publishing." };
      }

      // Run full Zod validation BEFORE any DB mutation so a failed validation
      // can never leave the offer in status="active" without a working config.
      const validation = await validateOffersPublishable(db, shopId, [offerId]);
      if (!validation.ok) return { error: validation.error };

      // Update status, push to Shopify, then rollback if the push fails.
      const now = new Date();
      await db.update(offers).set({ status: "active", updatedAt: now }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      const publishError = await publishShopConfig(shopId, session.shop);
      if (publishError) {
        await db.update(offers).set({ status: offer.status, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
        return { error: publishError };
      }

      // Snapshot with atomic version number: FOR UPDATE lock prevents two concurrent
      // publishes from computing the same version number and one silently dropping.
      const [offerSnapshot, condSnapshot, rewSnapshot, policySnapshot] = await Promise.all([
        db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1),
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
        db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
      ]);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM offers WHERE id = ${offerId} AND shop_id = ${shopId} FOR UPDATE`);
        const [lastVersion] = await tx
          .select({ versionNumber: offerVersions.versionNumber })
          .from(offerVersions)
          .where(and(eq(offerVersions.shopId, shopId), eq(offerVersions.offerId, offerId)))
          .orderBy(desc(offerVersions.versionNumber))
          .limit(1);
        const nextVersion = (lastVersion?.versionNumber ?? 0) + 1;
        await tx.insert(offerVersions).values({
          shopId,
          offerId,
          versionNumber: nextVersion,
          snapshot: { offer: offerSnapshot[0], conditions: condSnapshot, rewards: rewSnapshot, combinationPolicy: policySnapshot[0] ?? null },
          createdBy: session.shop,
        });
      });
      void insertAuditLog(db, { shopId, entityType: "offer", entityId: offerId, action: "publish", before: { status: offer.status }, after: { status: "active" }, performedBy: session.shop });

      break;
    }
    case "pause": {
      await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      if (offer.status === "active") {
        const publishError = await publishShopConfig(shopId, session.shop);
        if (publishError) {
          await db.update(offers).set({ status: offer.status, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
          return { error: publishError };
        }
      }
      void insertAuditLog(db, { shopId, entityType: "offer", entityId: offerId, action: "pause", before: { status: offer.status }, after: { status: "paused" }, performedBy: session.shop });
      break;
    }
    case "archive": {
      await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      if (offer.status === "active") {
        const publishError = await publishShopConfig(shopId, session.shop);
        if (publishError) {
          await db.update(offers).set({ status: offer.status, archivedAt: offer.archivedAt, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
          return { error: publishError };
        }
      }
      void insertAuditLog(db, { shopId, entityType: "offer", entityId: offerId, action: "archive", before: { status: offer.status }, after: { status: "archived" }, performedBy: session.shop });
      return redirect("/app/offers");
    }
    case "duplicate": {
      const [newOffer] = await db.insert(offers).values({
        ...offer, id: undefined as unknown as string, internalName: `${offer.internalName}-copy`,
        status: "draft", createdAt: new Date(), updatedAt: new Date(),
        // A copy must not inherit the source's checkout code or its Shopify
        // discount node id — both are 1:1 with the original offer (the DB's
        // partial unique index would reject a second non-archived offer
        // reusing the same code anyway), and reusing the discount node id
        // would let two different offers silently share one live discount.
        requiredDiscountCode: null, codeDiscountId: null,
        // The copy has none of the source's codes, so it must stay inert (never run
        // ungated) until codes are added: requiresCode keeps the gate.
        requiresCode: await offerRequiresCode(db, shopId, offer),
      }).returning({ id: offers.id });
      if (newOffer) return redirect(`/app/offers/${newOffer.id}`);
      break;
    }
  }

  return { success: true };
};


/* ── Condition type display names ───────────────────────── */
const CONDITION_TYPE_NAMES: Record<string, string> = {
  cart_value:            "Cart Value",
  cart_quantity:         "Cart Quantity",
  cart_value_multiplier: "Cart Value Multiplier",
  specific_product:      "Specific Product",
  pack_of_products:      "Pack of Products",
  customer_tags:         "Customer Tags",
  order_history_total_spent: "Order History — Total Spent",
  one_use_per_customer:  "One Use Per Customer",
  markets:               "Shopify Markets",
  customer_location:     "Customer Location",
  sales_channels:        "Sales Channels",
  page_url:              "Page URL",
};

/* ── Sub-condition rows (scope="sub") → subcondition-picker form state ──────
 * Reverses normalizeOfferSubconditions() so existing sub-conditions reopen
 * pre-filled instead of forcing the merchant to reconfigure them. Most forms
 * already read the same canonical field names the DB stores, so this is
 * mostly a conditionType → SubconditionId relabel; "quantity_limit" is the
 * one type whose stored shape (cart_quantity/specific_product rows) doesn't
 * map cleanly back to the picker's `rules` array, so it's left to the
 * merchant to reconfigure if already present. */
function subconditionsFromRows(
  rows: Array<{ conditionType: string; value: Record<string, unknown> }>,
): { activeSubs: SubconditionId[]; subValues: Record<string, unknown> } {
  const activeSubs: SubconditionId[] = [];
  const subValues: Record<string, unknown> = {};

  for (const row of rows) {
    const v = row.value;
    switch (row.conditionType) {
      case "specific_link":
        activeSubs.push("link");
        subValues["link"] = v;
        break;
      case "customer_tags":
        activeSubs.push("customer_tags");
        subValues["customer_tags"] = v;
        break;
      case "customer_location":
        activeSubs.push("location");
        subValues["location"] = v;
        break;
      case "subscription_product_type":
        activeSubs.push("subscription");
        subValues["subscription"] = v;
        break;
      case "sales_channels":
        activeSubs.push("sales_channel");
        subValues["sales_channel"] = v;
        break;
      case "utm_parameters":
        activeSubs.push("utm_parameters");
        subValues["utm_parameters"] = v;
        break;
      case "markets":
        activeSubs.push("markets");
        subValues["markets"] = v;
        break;
      case "cart_attribute":
        activeSubs.push("custom_attribute");
        subValues["custom_attribute"] = { ...v, scope: "cart" };
        break;
      case "line_attribute":
        activeSubs.push("custom_attribute");
        subValues["custom_attribute"] = { ...v, scope: "line" };
        break;
      case "one_use_per_customer":
        activeSubs.push("order_history");
        subValues["order_history"] = { metric: "one_use_per_customer" };
        break;
      case "order_history_total_spent":
      case "order_history_last_order_spent":
      case "order_history_total_orders": {
        activeSubs.push("order_history");
        const metric = row.conditionType === "order_history_total_orders"
          ? "total_orders"
          : row.conditionType === "order_history_last_order_spent"
            ? "last_order_spent"
            : "total_spent";
        const threshold = metric === "total_orders"
          ? Number(v["value"] ?? 0)
          : Number(v["valueCents"] ?? 0) / 100;
        subValues["order_history"] = { metric, operator: v["operator"] ?? "gte", threshold };
        break;
      }
      case "cart_quantity":
      case "specific_product":
        // Sub-scope quantity limits: mark as active so the card shows up,
        // but leave the value for the merchant to re-enter (see doc comment).
        if (!activeSubs.includes("quantity_limit")) activeSubs.push("quantity_limit");
        break;
      default:
        break;
    }
  }

  return { activeSubs, subValues };
}

/* ── Currency chips shown on monetary conditions ────────── */
const CURRENCIES = SUPPORTED_CURRENCIES;
const conditionCurrencyFormatters = new Map<string, Intl.NumberFormat>();

function getConditionCurrencyFormatter(currencyCode: string): Intl.NumberFormat {
  const key = currencyCode.toUpperCase();
  const cached = conditionCurrencyFormatters.get(key);
  if (cached) return cached;

  const formatter = Intl.NumberFormat("en-US", {
    style: "currency",
    currency: key,
    maximumFractionDigits: 2,
  });
  conditionCurrencyFormatters.set(key, formatter);
  return formatter;
}

function CurrencyChips({ selected, onSelect }: { selected: string; onSelect: (c: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? CURRENCIES : CURRENCIES.slice(0, 10);
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 6 }}>Add currency</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {visible.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onSelect(c)}
            className="rd-style-068" style={{ border: `1px solid ${selected === c ? "var(--blue)" : "var(--border)"}`, background: selected === c ? "var(--blue-light)" : "transparent", color: selected === c ? "var(--blue)" : "var(--text-sub)", fontWeight: selected === c ? 600 : 400 }}
          >
            {c}
          </button>
        ))}
        {!showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{ padding: "3px 8px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-sub)", cursor: "pointer" }}
          >
            …
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Applies-to select ──────────────────────────────────── */
function AppliesToSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
        Condition applies to:
      </div>
      <select
        aria-label="Condition applies to"
        className="b-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="any_product">Any product</option>
        <option value="specific_products">Specific products</option>
        <option value="specific_collection">Specific collection</option>
      </select>
    </div>
  );
}

/* ── Inline condition editor ────────────────────────────── */
type ConditionValue = Record<string, unknown>;

/* ── Code notices: an inert code offer, and codes published under a suffixed variant ── */
function CodeNoticeBanners({
  offerId,
  notices,
}: {
  offerId: string;
  notices: { inert: boolean; collisions: Array<{ id: string; code: string; requestedCode: string; existingDiscount: string | null }> };
}) {
  return (
    <>
      {notices.inert && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 12 }} role="alert">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>
              This offer needs a discount code, but none can be redeemed right now, so it is not live.{" "}
              <Link to={`/app/offers/${offerId}/codes`}>Manage codes</Link>
            </p>
          </div>
        </div>
      )}
      {notices.collisions.map((collision) => (
        <div key={collision.id} className="b-banner b-banner-orange" style={{ marginBottom: 12 }} role="status">
          <div className="b-banner-body">
            <p className="b-banner-text" style={{ margin: 0 }}>
              {collision.requestedCode} already exists in Shopify
              {collision.existingDiscount ? ` (discount "${collision.existingDiscount}")` : ""}; it was published as{" "}
              <strong>{collision.code}</strong>. <Link to={`/app/offers/${offerId}/codes`}>Retry the original code</Link>
            </p>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Page URL condition editor ──────────────────────────── */
function PageUrlConditionEditor({
  conditionId,
  val,
  update,
  save,
  isCodePromo,
}: {
  conditionId: string;
  val: ConditionValue;
  update: (patch: Partial<ConditionValue>) => void;
  save: (overrideVal?: ConditionValue) => void;
  isCodePromo: boolean;
}) {
  const patterns = Array.isArray(val.patterns) ? (val.patterns as string[]) : [""];
  const matchMode = (val.matchMode as string | undefined) ?? "starts_with";
  const caseSensitive = Boolean(val.caseSensitive);
  const onlyMatchedLines = resolveOnlyMatchedLines(val.onlyMatchedLines, isCodePromo);

  function setPatterns(next: string[]) {
    const nextVal = { ...val, patterns: next };
    update({ patterns: next });
    save(nextVal);
  }

  function updatePattern(index: number, newValue: string) {
    const next = patterns.map((p, i) => (i === index ? newValue : p));
    update({ patterns: next });
  }

  function savePatterns() {
    save({ ...val, patterns });
  }

  function addPattern() {
    setPatterns([...patterns, ""]);
  }

  function removePattern(index: number) {
    const next = patterns.filter((_, i) => i !== index);
    setPatterns(next.length > 0 ? next : [""]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label htmlFor={`condition-${conditionId}-match-mode`} style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>
          Match mode
        </label>
        <select
          id={`condition-${conditionId}-match-mode`}
          aria-label="URL match mode"
          className="b-select"
          value={matchMode}
          onChange={(e) => {
            const next = { ...val, matchMode: e.target.value };
            update({ matchMode: e.target.value });
            save(next);
          }}
        >
          <option value="exact">Exact — pathname must equal pattern exactly</option>
          <option value="starts_with">Starts with — pathname begins with pattern</option>
          <option value="contains">Contains — pattern appears anywhere in pathname</option>
          <option value="ends_with">Ends with — pathname ends with pattern</option>
        </select>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Matching is applied to the URL path (e.g. <code>/collections/sale</code>). Any pattern match activates the offer.
        </div>
      </div>

      <div>
        <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 6 }}>URL patterns</div>
        {patterns.map((pattern, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
            <input
              aria-label={`URL pattern ${i + 1}`}
              className="b-input"
              type="text"
              placeholder="/collections/sale"
              value={pattern}
              onChange={(e) => updatePattern(i, e.target.value)}
              onBlur={() => savePatterns()}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              aria-label="Remove pattern"
              onClick={() => removePattern(i)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#dc2626", fontSize: 16, lineHeight: 1, padding: "2px 6px", flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="b-btn b-btn-secondary b-btn-sm"
          onClick={addPattern}
          style={{ marginTop: 2 }}
        >
          + Add pattern
        </button>
      </div>

      <div className="b-checkbox-row">
        <input
          type="checkbox"
          id={`condition-${conditionId}-case-sensitive`}
          aria-label="Case sensitive matching"
          checked={caseSensitive}
          onChange={(e) => {
            const next = { ...val, caseSensitive: e.target.checked };
            update({ caseSensitive: e.target.checked });
            save(next);
          }}
          style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
        />
        <div>
          <label htmlFor={`condition-${conditionId}-case-sensitive`} className="b-checkbox-label">
            Case-sensitive matching
          </label>
          <div className="b-checkbox-help">
            By default matching is case-insensitive. Enable to match exact casing.
          </div>
        </div>
      </div>

      <OnlyMatchedLinesCheckbox
        id={`condition-${conditionId}-only-matched-lines`}
        checked={onlyMatchedLines}
        onChange={(checked) => {
          update({ onlyMatchedLines: checked });
          save({ ...val, onlyMatchedLines: checked });
        }}
      />
    </div>
  );
}

function ConditionCard({
  conditionId,
  conditionType,
  initialValue,
  onDelete,
  isCodePromo,
}: {
  conditionId: string;
  conditionType: string;
  initialValue: ConditionValue;
  onDelete: () => void;
  isCodePromo: boolean;
}) {
  const fetcher = useFetcher();
  const isSaving = fetcher.state !== "idle";
  const [val, setVal] = useState<ConditionValue>({ ...initialValue });
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const selectedVariantIds = Array.isArray(val.variantIds) ? (val.variantIds as string[]) : [];

  function update(patch: Partial<ConditionValue>) {
    setVal((prev) => ({ ...prev, ...patch }));
  }

  function save(overrideVal?: ConditionValue) {
    const fd = new FormData();
    fd.append("intent", "update_condition");
    fd.append("conditionId", conditionId);
    fd.append("conditionValue", JSON.stringify(overrideVal ?? val));
    void fetcher.submit(fd, { method: "POST" });
  }

  const title = CONDITION_TYPE_NAMES[conditionType] ?? conditionType;

  return (
    <div style={{
      background: "white",
      border: "1px solid var(--border)",
      borderRadius: "var(--r)",
      overflow: "hidden",
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        background: "var(--bg-hover)",
        borderBottom: "1px solid var(--border-light)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{title}</span>
          {isSaving && (
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>Saving…</span>
          )}
        </div>
        <button
          type="button"
          onClick={onDelete}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#dc2626", fontSize: 16, lineHeight: 1, padding: "2px 4px",
          }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: "16px" }}>
        {/* ── Cart value ────────────────────────────────────── */}
        {conditionType === "cart_value" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
              <div>
                <label htmlFor={`condition-${conditionId}-min`} style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Min.</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
                  <input
                    id={`condition-${conditionId}-min`}
                    aria-label="Minimum cart value"
                    className="b-input"
                    type="number"
                    style={{ paddingLeft: 22 }}
                    value={String((val.thresholdCents as number ?? 50000) / 100)}
                    onChange={(e) => update({ thresholdCents: Math.round(parseFloat(e.target.value || "0") * 100) })}
                    onBlur={() => save()}
                    step="0.01"
                  />
                </div>
              </div>
              <div>
                <label htmlFor={`condition-${conditionId}-max`} style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Max.</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
                  <input
                    id={`condition-${conditionId}-max`}
                    aria-label="Maximum cart value"
                    className="b-input"
                    type="number"
                    style={{ paddingLeft: 22 }}
                    value={String((val.maxCents as number ?? 0) / 100)}
                    onChange={(e) => update({ maxCents: Math.round(parseFloat(e.target.value || "0") * 100) })}
                    onBlur={() => save()}
                    step="0.01"
                  />
                </div>
              </div>
              <div style={{ height: 36, width: 24 }} />
            </div>
            <CurrencyChips
              selected={val.currencyCode as string ?? "USD"}
              onSelect={(c) => { const next = { ...val, currencyCode: c }; setVal(next); save(next); }}
            />
            <AppliesToSelect
              value={val.appliesTo as string ?? "any_product"}
              onChange={(v) => { const next = { ...val, appliesTo: v }; setVal(next); save(next); }}
            />
          </>
        )}

        {/* ── Cart value multiplier ──────────────────────────── */}
        {conditionType === "cart_value_multiplier" && (
          <>
            <label htmlFor={`condition-${conditionId}-multiplier`} style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
              Multiply base value
            </label>
            <div style={{ position: "relative", maxWidth: 200 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
              <input
                id={`condition-${conditionId}-multiplier`}
                aria-label="Multiply base value"
                className="b-input"
                type="number"
                style={{ paddingLeft: 22 }}
                value={String((val.thresholdCents as number ?? 50000) / 100)}
                onChange={(e) => update({ thresholdCents: Math.round(parseFloat(e.target.value || "0") * 100) })}
                onBlur={() => save()}
              />
            </div>
            <p style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 8, marginBottom: 0 }}>
              For example: when the base value is set to $100, the customer will receive 1 gift when the cart value is greater than $100, 2 gifts when it exceeds $200.
            </p>
            <CurrencyChips
              selected={val.currencyCode as string ?? "USD"}
              onSelect={(c) => { const next = { ...val, currencyCode: c }; setVal(next); save(next); }}
            />
            <AppliesToSelect
              value={val.appliesTo as string ?? "any_product"}
              onChange={(v) => { const next = { ...val, appliesTo: v }; setVal(next); save(next); }}
            />
          </>
        )}

        {/* ── Cart quantity ──────────────────────────────────── */}
        {conditionType === "cart_quantity" && (
          <>
            <div className="b-grid-2">
              <div>
                <label htmlFor={`condition-${conditionId}-min-quantity`} style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Min. quantity</label>
                <input
                  id={`condition-${conditionId}-min-quantity`}
                  aria-label="Minimum quantity"
                  className="b-input"
                  type="number"
                  min="1"
                  value={String(val.minQuantity ?? 1)}
                  onChange={(e) => update({ minQuantity: parseInt(e.target.value, 10) || 1 })}
                  onBlur={() => save()}
                />
              </div>
              <div>
                <label htmlFor={`condition-${conditionId}-max-quantity`} style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Max. quantity (optional)</label>
                <input
                  id={`condition-${conditionId}-max-quantity`}
                  aria-label="Maximum quantity"
                  className="b-input"
                  type="number"
                  min="0"
                  value={String(val.maxQuantity ?? "")}
                  onChange={(e) => update({ maxQuantity: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                  onBlur={() => save()}
                />
              </div>
            </div>
            <AppliesToSelect
              value={val.appliesTo as string ?? "any_product"}
              onChange={(v) => { const next = { ...val, appliesTo: v }; setVal(next); save(next); }}
            />
          </>
        )}

        {/* ── Specific product ───────────────────────────────── */}
        {(conditionType === "specific_product" || conditionType === "pack_of_products") && (
          <>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={`condition-${conditionId}-required-products`} style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
                Required number of products
              </label>
              <input
                id={`condition-${conditionId}-required-products`}
                aria-label="Required number of products"
                className="b-input"
                type="number"
                min="1"
                style={{ maxWidth: 200 }}
                value={String(val.minQtyPerProduct ?? 1)}
                onChange={(e) => update({ minQtyPerProduct: parseInt(e.target.value, 10) || 1 })}
                onBlur={() => save()}
              />
            </div>

            <div className="b-checkbox-row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                id={`multiplyGifts-${conditionId}`}
                aria-label="Multiply gifts with number of products"
                checked={Boolean(val.multiplyGifts)}
                onChange={(e) => { const next = { ...val, multiplyGifts: e.target.checked }; setVal(next); save(next); }}
                style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
              />
              <div>
                <label htmlFor={`multiplyGifts-${conditionId}`} className="b-checkbox-label">
                  Multiply gifts with number of products
                </label>
                <div className="b-checkbox-help">
                  This feature allows customers to get more gifts by buying more products.
                </div>
              </div>
            </div>

            <div className="b-checkbox-row" style={{ marginBottom: val.giftsMatchProducts ? 6 : 14 }}>
              <input
                type="checkbox"
                id={`giftsMatch-${conditionId}`}
                aria-label="Gifts will be the same as selected products"
                checked={Boolean(val.giftsMatchProducts)}
                onChange={(e) => { const next = { ...val, giftsMatchProducts: e.target.checked }; setVal(next); save(next); }}
                style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
              />
              <label htmlFor={`giftsMatch-${conditionId}`} className="b-checkbox-label">
                Gifts will be the same as selected products.
              </label>
            </div>

            {Boolean(val.giftsMatchProducts) && (
              <div style={{ paddingLeft: 25, marginBottom: 14 }}>
                {["variant", "product"].map((mode) => (
                  <div key={mode} className="b-checkbox-row" style={{ marginBottom: 6 }}>
                    <input
                      type="radio"
                      id={`trackMode-${mode}-${conditionId}`}
                      aria-label={mode === "variant" ? "Track by variant" : "Track by product"}
                      name={`trackMode-${conditionId}`}
                      checked={val.trackMode === mode}
                      onChange={() => { const next = { ...val, trackMode: mode }; setVal(next); save(next); }}
                      style={{ accentColor: "var(--blue)", width: 14, height: 14 }}
                    />
                    <label htmlFor={`trackMode-${mode}-${conditionId}`} className="b-checkbox-label">
                      {mode === "variant" ? "Track by variant" : "Track by product"}
                    </label>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label htmlFor={`condition-${conditionId}-specific-applies-to`} style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
                The condition applies to:
              </label>
              <select
                id={`condition-${conditionId}-specific-applies-to`}
                aria-label="The condition applies to"
                className="b-select"
                value="specific_products"
                onChange={() => {}}
                disabled
              >
                <option value="specific_products">products selected</option>
              </select>
            </div>

            <div className="b-gift-selector-row" style={{ marginTop: 0 }}>
              <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setProductPickerOpen(true)}>
                Select products
              </button>
            </div>
            <SelectedProductsList
              gids={selectedVariantIds}
              onRemove={(gid) => { const next = { ...val, variantIds: selectedVariantIds.filter((id) => id !== gid) }; setVal(next); save(next); }}
            />

            <ProductPicker
              open={productPickerOpen}
              onClose={() => setProductPickerOpen(false)}
              title="Select condition products"
              selectedIds={selectedVariantIds}
              onSelect={(gids) => { const next = { ...val, variantIds: gids }; setVal(next); save(next); }}
            />
          </>
        )}

        {/* ── Page URL ───────────────────────────────────────── */}
        {conditionType === "page_url" && (
          <PageUrlConditionEditor conditionId={conditionId} val={val} update={update} save={save} isCodePromo={isCodePromo} />
        )}
      </div>
    </div>
  );
}

/* ── Summary sidebar item ────────────────────────────────── */
function SummaryItem({
  label,
  done,
  details,
  onClick,
}: {
  label: string;
  done: boolean;
  details?: string[];
  onClick?: () => void;
}) {
  return (
    <div
      className="b-summary-item"
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      <div
        className={`b-summary-circle${done ? " b-summary-circle-done" : ""}`}
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        {done && (
          <span style={{ color: "var(--green-txt)", display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            <IconCheck />
          </span>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <div className="b-summary-label">{label}</div>
        {done && details && details.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
            {details.map((d, i) => (
              <div key={d} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
                  {i === 0 ? <IconLink /> : <IconCondition />}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-sub)" }}>{d}</span>
              </div>
            ))}
          </div>
        ) : !done ? (
          <div className="b-summary-add">
            <IconPlus /> Click to add
          </div>
        ) : null}
      </div>
    </div>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Condition summary text from DB value ────────────────── */
function conditionSummary(conditionType: string, value: ConditionValue, currencyCode = "USD"): string[] {
  const v = value;
  const conditionCurrency = (v.currencyCode as string | undefined) ?? currencyCode;
  const fmt = (cents: number) => {
    try {
      return getConditionCurrencyFormatter(conditionCurrency).format(cents / 100);
    } catch {
      return `${conditionCurrency} ${(cents / 100).toFixed(2)}`;
    }
  };
  switch (conditionType) {
    case "cart_value": {
      const cents = v.thresholdCents as number ?? 50000;
      const applies = v.appliesTo === "specific_products" ? "specific products" : "any product";
      return [`Spend from ${fmt(cents)} to get 1 gift(s)`, `Applies to ${applies}`];
    }
    case "cart_value_multiplier": {
      const cents = v.thresholdCents as number ?? 50000;
      const applies = v.appliesTo === "specific_products" ? "specific products" : "any product";
      return [`Spend ${fmt(cents)} to get 1 gift(s)`, `Applies to ${applies}`];
    }
    case "cart_quantity": {
      const min = v.minQuantity as number ?? 1;
      return [`Buy at least ${min} item(s)`];
    }
    case "specific_product": {
      const qty = v.minQtyPerProduct as number ?? 1;
      const ids = Array.isArray(v.variantIds) ? (v.variantIds as string[]).length : 0;
      return [`Buy ${qty} item(s) of products to get 1 gift(s)`, `Applies to ${ids} products selected`];
    }
    case "page_url": {
      const mode = (v.matchMode as string | undefined) ?? "starts_with";
      const patterns = Array.isArray(v.patterns) ? (v.patterns as string[]) : [];
      const label = mode.replace("_", " ");
      if (patterns.length === 0) return ["No URL patterns configured"];
      return [`URL ${label}: ${patterns.slice(0, 2).join(", ")}${patterns.length > 2 ? ` +${patterns.length - 2} more` : ""}`];
    }
    default:
      return [conditionType];
  }
}

/* ── Start date display ──────────────────────────────────── */
function formatStartDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `Starts ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/* ═══════════════════════════════════════════════════════════
   PAGE COMPONENT
   ═══════════════════════════════════════════════════════════ */
export default function OfferDetailPage() {
  const { offer, conditions, rewards, policy, shopCurrencyCode, isCodePromo, codeNotices } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const fetcher = useFetcher();

  const firstReward = rewards[0] as typeof rewards[0] | undefined;
  const [detailState, setDetailField] = useObjectState(() => ({
    internalName: offer.internalName,
    publicTitle: offer.publicTitle ?? "",
    startsAt: offer.startsAt ? new Date(offer.startsAt).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16),
    endsAt: offer.endsAt ? new Date(offer.endsAt).toISOString().slice(0, 16) : "",
    discountType: firstReward?.discountType ?? "free",
    discountValue: String((firstReward?.value as { amount?: number } | null)?.amount ?? 100),
    receivesAll: firstReward?.isAutoAdd !== false,
    giftCount: String(firstReward?.quantity ?? 1),
    addingCondition: false,
    newCondType: "",
    advancedOpen: false,
  }));
  const {
    internalName,
    publicTitle,
    startsAt,
    endsAt,
    discountType,
    discountValue,
    receivesAll,
    giftCount,
    addingCondition,
    newCondType,
    advancedOpen,
  } = detailState;
  const setInternalName = createFieldSetter(setDetailField, "internalName");
  const setPublicTitle = createFieldSetter(setDetailField, "publicTitle");
  const setStartsAt = createFieldSetter(setDetailField, "startsAt");
  const setEndsAt = createFieldSetter(setDetailField, "endsAt");
  const setDiscountType = createFieldSetter(setDetailField, "discountType");
  const setDiscountValue = createFieldSetter(setDetailField, "discountValue");
  const setReceivesAll = createFieldSetter(setDetailField, "receivesAll");
  const setGiftCount = createFieldSetter(setDetailField, "giftCount");
  const setAddingCondition = createFieldSetter(setDetailField, "addingCondition");
  const setNewCondType = createFieldSetter(setDetailField, "newCondType");
  const setAdvancedOpen = createFieldSetter(setDetailField, "advancedOpen");

  const initialGiftIds = (firstReward?.target as { variantIds?: string[] } | null)?.variantIds ?? [];
  const [giftProductIds, setGiftProductIds] = useState<string[]>(initialGiftIds);
  const [giftPickerOpen, setGiftPickerOpen] = useState(false);

  const initialFallbackIds = (firstReward?.target as { fallbackVariantIds?: string[] } | null)?.fallbackVariantIds ?? [];
  const [fallbackProductIds, setFallbackProductIds] = useState<string[]>(initialFallbackIds);
  const [fallbackPickerOpen, setFallbackPickerOpen] = useState(false);

  // Persist the reward (discount type/value/qty/auto-add + product target).
  // The editor previously never submitted update_reward, so gift edits were lost.
  // Accepts explicit overrides so callers that also setState don't read a stale closure.
  function saveReward(overrides?: {
    discountType?: string;
    discountValue?: string;
    giftCount?: string;
    receivesAll?: boolean;
    variantIds?: string[];
    fallbackVariantIds?: string[];
  }) {
    if (!firstReward) return;
    const fd = new FormData();
    fd.append("intent", "update_reward");
    fd.append("rewardId", firstReward.id);
    fd.append("discountType", overrides?.discountType ?? discountType);
    fd.append("discountValue", overrides?.discountValue ?? discountValue);
    fd.append("quantity", overrides?.giftCount ?? giftCount);
    if (overrides?.receivesAll ?? receivesAll) fd.append("isAutoAdd", "on");
    fd.append("targetVariantIds", JSON.stringify(overrides?.variantIds ?? giftProductIds));
    fd.append("targetFallbackVariantIds", JSON.stringify(overrides?.fallbackVariantIds ?? fallbackProductIds));
    void fetcher.submit(fd, { method: "POST" });
  }

  const canPublish = offer.status === "draft" || offer.status === "paused";
  const hasName = Boolean(internalName.trim());
  const hasConditions = conditions.length > 0;
  const hasRewards = rewards.length > 0;

  const mainConditions = conditions.filter((c) => c.scope === "main");
  const subConditions = conditions.filter((c) => c.scope === "sub");

  const initialSubs = subconditionsFromRows(subConditions);
  const [subState, setSubField] = useObjectState(() => ({
    subModalOpen: false,
    activeSubs: initialSubs.activeSubs,
    subValues: initialSubs.subValues,
    collapsedSubs: {} as Record<string, boolean>,
  }));
  const { subModalOpen, activeSubs, subValues, collapsedSubs } = subState;
  const setSubModalOpen = createFieldSetter(setSubField, "subModalOpen");
  const setActiveSubs = createFieldSetter(setSubField, "activeSubs");
  const setSubValues = createFieldSetter(setSubField, "subValues");
  const setCollapsedSubs = createFieldSetter(setSubField, "collapsedSubs");

  // Sub-conditions are managed as one unit (mirrors the creation wizard): every
  // change — toggling a type on/off in the modal, or editing an active one's
  // fields — resubmits the whole set so the server can validate and replace
  // it atomically.
  function saveSubconditions(nextActiveSubs: SubconditionId[], nextSubValues: Record<string, unknown>) {
    const payload: Record<string, unknown> = {};
    for (const id of nextActiveSubs) payload[id] = nextSubValues[id] ?? {};
    const fd = new FormData();
    fd.append("intent", "save_subconditions");
    fd.append("subconditions", JSON.stringify(payload));
    void fetcher.submit(fd, { method: "POST" });
  }

  function handleSubconditionsConfirm(ids: SubconditionId[]) {
    setActiveSubs(ids);
    saveSubconditions(ids, subValues);
  }

  function removeSubcondition(id: SubconditionId) {
    const nextActive = activeSubs.filter((x) => x !== id);
    setActiveSubs(nextActive);
    saveSubconditions(nextActive, subValues);
  }

  function updateSubconditionValue(id: SubconditionId, value: Record<string, unknown>) {
    const nextValues = { ...subValues, [id]: value };
    setSubValues(nextValues);
    saveSubconditions(activeSubs, nextValues);
  }

  function saveInfo() {
    const fd = new FormData();
    fd.append("intent", "update");
    fd.append("internalName", internalName);
    fd.append("publicTitle", publicTitle);
    fd.append("startsAt", startsAt);
    fd.append("endsAt", endsAt);
    void fetcher.submit(fd, { method: "POST" });
  }

  function deleteCondition(conditionId: string) {
    const fd = new FormData();
    fd.append("intent", "delete_condition");
    fd.append("conditionId", conditionId);
    void fetcher.submit(fd, { method: "POST" });
  }

  function addCondition() {
    if (!newCondType) return;
    const defaults: Record<string, object> = {
      cart_value: { thresholdCents: 50000, currencyCode: "USD", appliesTo: "any_product" },
      cart_quantity: { minQuantity: 1, appliesTo: "any_product" },
      cart_value_multiplier: { thresholdCents: 50000, currencyCode: "USD", appliesTo: "any_product" },
      specific_product: { minQtyPerProduct: 1, multiplyGifts: false, giftsMatchProducts: false, trackMode: "variant", appliesTo: "specific_products", variantIds: [] },
      page_url: { patterns: [""], matchMode: "starts_with", caseSensitive: false },
    };
    const fd = new FormData();
    fd.append("intent", "add_condition");
    fd.append("conditionType", newCondType);
    fd.append("scope", "main");
    fd.append("conditionValue", JSON.stringify(defaults[newCondType] ?? {}));
    void fetcher.submit(fd, { method: "POST" });
    setAddingCondition(false);
    setNewCondType("");
  }

  function submitAction(intent: string) {
    const fd = new FormData();
    fd.append("intent", intent);
    void fetcher.submit(fd, { method: "POST" });
  }

  if (offer.type !== "gift") {
    return (
      <div className="b-page">
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="b-btn-plain b-text-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 10 }}
            onClick={() => navigate("/app/offers")}
          >
            <IconChevronLeft />
            All Offers
          </button>
        </div>

        <div className="b-editor-layout">
          <div className="b-editor-main">
            <div className="b-editor-section">
              <p className="b-editor-section-title">Offer information</p>
              <div className="b-editor-section-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <label className="b-label" htmlFor="internalName">Offer name</label>
                  <input
                    id="internalName"
                    className="b-input"
                    value={internalName}
                    onChange={(e) => setInternalName(e.target.value)}
                    onBlur={saveInfo}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="publicTitle">Offer title</label>
                  <input
                    id="publicTitle"
                    className="b-input"
                    value={publicTitle}
                    onChange={(e) => setPublicTitle(e.target.value)}
                    onBlur={saveInfo}
                    autoComplete="off"
                  />
                </div>
                <div className="b-datetime-row">
                  <div>
                    <label className="b-label" htmlFor="offer-start-time">Start time</label>
                    <input id="offer-start-time" className="b-input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} onBlur={saveInfo} />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="offer-end-time">End time</label>
                    <input id="offer-end-time" className="b-input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} onBlur={saveInfo} />
                  </div>
                </div>
              </div>
            </div>

            <div className="b-editor-section">
              <p className="b-editor-section-title">{offer.type[0]?.toUpperCase()}{offer.type.slice(1)} configuration</p>
              <div className="b-editor-section-body">
                <div className="b-mb-4">
                  <OfferStepTabs offerId={offer.id} />
                </div>
                <div className="b-stack b-stack-3">
                  <Link
                    to={`/app/offers/${offer.id}/conditions`}
                    className="b-card"
                    style={{ display: "block", color: "inherit", textDecoration: "none", cursor: "pointer" }}
                  >
                    <div className="b-card-header" style={{ justifyContent: "space-between" }}>
                      <span>Conditions</span>
                      <span className="b-row b-gap-2" style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                        Edit <IconChevronRight />
                      </span>
                    </div>
                    <div className="b-card-body">
                      {conditions.length > 0 ? conditions.map((condition) => (
                        <p key={condition.id} className="b-text-sm" style={{ margin: "0 0 6px" }}>
                          {CONDITION_TYPE_NAMES[condition.conditionType] ?? condition.conditionType}
                        </p>
                      )) : <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>No conditions configured.</p>}
                    </div>
                  </Link>
                  <Link
                    to={`/app/offers/${offer.id}/rewards`}
                    className="b-card"
                    style={{ display: "block", color: "inherit", textDecoration: "none", cursor: "pointer" }}
                  >
                    <div className="b-card-header" style={{ justifyContent: "space-between" }}>
                      <span>Rewards</span>
                      <span className="b-row b-gap-2" style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                        Edit <IconChevronRight />
                      </span>
                    </div>
                    <div className="b-card-body">
                      {rewards.length > 0 ? rewards.map((reward) => (
                        <p key={reward.id} className="b-text-sm" style={{ margin: "0 0 6px" }}>
                          {reward.rewardType} - {reward.discountType}
                        </p>
                      )) : <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>No rewards configured.</p>}
                    </div>
                  </Link>
                </div>
              </div>
            </div>

            <CodeNoticeBanners offerId={offer.id} notices={codeNotices} />
            {actionData && "error" in actionData && actionData.error && (
              <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
                <span className="b-banner-icon">!</span>
                <div className="b-banner-body">
                  <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
                </div>
              </div>
            )}
            {actionData && "success" in actionData && actionData.success && (
              <div className="b-banner b-banner-green" style={{ marginBottom: 12 }}>
                <span className="b-banner-icon">✓</span>
                <div className="b-banner-body">
                  <p className="b-banner-text" style={{ margin: 0 }}>Saved successfully.</p>
                </div>
              </div>
            )}

            <div className="b-editor-footer">
              <button type="button" className="b-btn b-btn-secondary" onClick={saveInfo}>Save draft</button>
              {canPublish ? (
                <button type="button" className="b-btn b-btn-dark" onClick={() => submitAction("publish")}>Publish</button>
              ) : (
                <button type="button" className="b-btn b-btn-secondary" onClick={() => submitAction("pause")}>Pause</button>
              )}
            </div>
          </div>

          <div className="b-editor-sidebar">
            <div className="b-card">
              <div className="b-card-header">Summary</div>
              <div className="b-card-body">
                <p className="b-text-sm" style={{ margin: "0 0 6px" }}>Type: {offer.type}</p>
                <p className="b-text-sm" style={{ margin: "0 0 6px" }}>Status: {offer.status}</p>
                <p className="b-text-sm" style={{ margin: 0 }}>{formatStartDate(offer.startsAt)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="b-page">
      {/* ── Back + Title ─────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="b-btn-plain b-text-sm"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 10 }}
          onClick={() => navigate("/app/offers")}
        >
          <IconChevronLeft />
          {offer.type === "gift" ? "Gift offers" : offer.type === "bundle" ? "Bundle offers" : offer.type === "upsell" ? "Upsell offers" : "All offers"}
        </button>
      </div>

      <div className="b-editor-layout">
        {/* ── LEFT COLUMN ─────────────────────────────────── */}
        <div className="b-editor-main">

          {/* Offer info ──────────────────────────────────── */}
          <div className="b-editor-section" id="section-offer-info">
            <p className="b-editor-section-title">Offer information</p>
            <div className="b-editor-section-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label className="b-label" htmlFor="internalName">Offer name</label>
                <input
                  id="internalName"
                  className="b-input"
                  value={internalName}
                  onChange={(e) => setInternalName(e.target.value)}
                  onBlur={saveInfo}
                  placeholder="Enter offer name"
                  autoComplete="off"
                />
                <div className="b-help">For internal use only, not shown to customers..</div>
              </div>
              <div>
                <label className="b-label" htmlFor="publicTitle">Offer title</label>
                <input
                  id="publicTitle"
                  className="b-input"
                  value={publicTitle}
                  onChange={(e) => setPublicTitle(e.target.value)}
                  onBlur={saveInfo}
                  placeholder="Enter offer title"
                  autoComplete="off"
                />
                <div className="b-help">Shown to customers in the online store.</div>
              </div>
              <div className="b-datetime-row">
                <div>
                  <label className="b-label" htmlFor="offer-start-time">Start time</label>
                  <input
                    id="offer-start-time"
                    aria-label="Start time"
                    className="b-input"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    onBlur={saveInfo}
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="offer-end-time">End time</label>
                  <input
                    id="offer-end-time"
                    aria-label="End time"
                    className="b-input"
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    onBlur={saveInfo}
                    placeholder="End time"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Main condition ──────────────────────────────── */}
          <div className="b-editor-section" id="section-main-condition">
            <p className="b-editor-section-title">Offer main condition</p>
            <div className="b-editor-section-body">
              {mainConditions.map((c) => (
                <ConditionCard
                  key={c.id}
                  conditionId={c.id}
                  conditionType={c.conditionType}
                  initialValue={c.value as ConditionValue}
                  onDelete={() => deleteCondition(c.id)}
                  isCodePromo={isCodePromo}
                />
              ))}

              {/* Add new condition form */}
              {addingCondition ? (
                <div style={{ marginBottom: 12 }}>
                  <label className="b-label" htmlFor="new-condition-type">Condition type</label>
                  <select
                    id="new-condition-type"
                    aria-label="Condition type"
                    className="b-select"
                    value={newCondType}
                    onChange={(e) => setNewCondType(e.target.value)}
                    style={{ marginBottom: 10 }}
                  >
                    <option value="">— Select —</option>
                    <option value="cart_value">Cart Value — spend threshold</option>
                    <option value="cart_quantity">Cart Quantity — item count</option>
                    <option value="cart_value_multiplier">Cart Value Multiplier — earn gifts per $ spent</option>
                    <option value="specific_product">Specific Product — must contain selected products</option>
                    <option value="page_url">Page URL — restrict to specific storefront pages</option>
                  </select>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="b-btn b-btn-dark b-btn-sm"
                      onClick={addCondition}
                      disabled={!newCondType}
                    >
                      Add condition
                    </button>
                    <button
                      type="button"
                      className="b-btn b-btn-secondary b-btn-sm"
                      onClick={() => { setAddingCondition(false); setNewCondType(""); }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="b-btn-dark rd-style-069" style={{ opacity: mainConditions.length >= 2 ? 0.5 : 1, cursor: mainConditions.length >= 2 ? "not-allowed" : "pointer" }}
                  onClick={() => mainConditions.length < 2 && setAddingCondition(true)}
                >
                  <IconPlus /> Add main condition
                </button>
              )}

              <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                Cart quantity and cart value conditions can be combined
              </p>
            </div>
          </div>

          {/* Subcondition ────────────────────────────────── */}
          <div>
            {activeSubs.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {activeSubs.map((id) => {
                  const def = GIFT_SUBCONDITIONS.find((s) => s.id === id)!;
                  const SubForm = SUB_FORMS[id];
                  return (
                    <SubconditionCard
                      key={id}
                      def={def}
                      collapsed={!!collapsedSubs[id]}
                      onToggleCollapse={() => setCollapsedSubs({ ...collapsedSubs, [id]: !collapsedSubs[id] })}
                      onRemove={() => removeSubcondition(id)}
                    >
                      <SubForm
                        value={subValues[id] as Record<string, unknown> | undefined}
                        onChange={(v) => updateSubconditionValue(id, v)}
                        isCodePromo={isCodePromo}
                      />
                    </SubconditionCard>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="b-subcondition-row"
              style={{ width: "100%", textAlign: "left", font: "inherit" }}
              onClick={() => setSubModalOpen(true)}
            >
              <IconRefresh />
              <span style={{ fontSize: 14, color: "var(--text-sub)" }}>
                {activeSubs.length > 0
                  ? `${activeSubs.length} subcondition(s) configured — click to edit`
                  : "Add subcondition (optional)"}
              </span>
            </button>
          </div>

          <SubconditionModal
            open={subModalOpen}
            active={activeSubs}
            types={GIFT_SUBCONDITIONS}
            onClose={() => setSubModalOpen(false)}
            onConfirm={handleSubconditionsConfirm}
          />

          {/* Select gifts ────────────────────────────────── */}
          <div className="b-editor-section" id="section-gift-reward">
            <p className="b-editor-section-title">Select gifts</p>
            <div className="b-editor-section-body">
              <p className="b-text-sm b-text-bold" style={{ marginBottom: 10 }}>Gift discount type</p>
              <div className="b-discount-type-row">
                <div>
                  <div className="b-discount-type-label">Type:</div>
                  <select aria-label="Gift discount type" className="b-select" value={discountType} onChange={(e) => { const v = e.target.value as typeof discountType; setDiscountType(v); saveReward({ discountType: v }); }}>
                    <option value="free">Free</option>
                    <option value="percentage">Percentage</option>
                    <option value="fixed_amount">Fixed amount</option>
                  </select>
                </div>
                <div>
                  <div className="b-discount-type-label">Value:</div>
                  <div style={{ position: "relative" }}>
                    {discountType !== "free" && (
                      <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13, pointerEvents: "none" }}>
                        {discountType === "percentage" ? "%" : "$"}
                      </span>
                    )}
                    <input
                      aria-label="Gift discount value"
                      className="b-input"
                      type="number"
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      onBlur={() => saveReward()}
                      disabled={discountType === "free"}
                      style={{ paddingLeft: discountType !== "free" ? 26 : 12 }}
                      min="0"
                      max={discountType === "percentage" ? "100" : undefined}
                    />
                  </div>
                </div>
              </div>

              <p className="b-text-sm b-text-bold" style={{ marginBottom: 10 }}>The customer will receive:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                <div className="b-checkbox-row">
                  <input
                    type="radio"
                    id="all-gifts"
                    aria-label="Automatically all gifts"
                    name="receives"
                    checked={receivesAll}
                    onChange={() => { setReceivesAll(true); saveReward({ receivesAll: true }); }}
                    style={{ accentColor: "var(--blue)", width: 15, height: 15 }}
                  />
                  <label htmlFor="all-gifts" className="b-checkbox-label">
                    Automatically all gifts
                  </label>
                </div>
                <div className="b-checkbox-row" style={{ alignItems: "center" }}>
                  <input
                    type="radio"
                    id="num-gifts"
                    aria-label="Number of gifts the customer will receive"
                    name="receives"
                    checked={!receivesAll}
                    onChange={() => { setReceivesAll(false); saveReward({ receivesAll: false }); }}
                    style={{ accentColor: "var(--blue)", width: 15, height: 15, marginTop: 2 }}
                  />
                  <div>
                    <label htmlFor="num-gifts" className="b-checkbox-label">
                      Number of gifts the customer will receive
                    </label>
                    {!receivesAll && (
                      <input
                        aria-label="Gift count"
                        className="b-input"
                        type="number"
                        value={giftCount}
                        onChange={(e) => setGiftCount(e.target.value)}
                        onBlur={() => saveReward()}
                        min="1"
                        style={{ maxWidth: 120, marginLeft: 8, height: 30 }}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="b-gift-selector-row">
                <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setGiftPickerOpen(true)} disabled={!firstReward}>Select gifts</button>
              </div>
              <SelectedProductsList
                gids={giftProductIds}
                onRemove={(gid) => {
                  const next = giftProductIds.filter((id) => id !== gid);
                  setGiftProductIds(next);
                  saveReward({ variantIds: next });
                }}
              />

              <ProductPicker
                open={giftPickerOpen}
                onClose={() => setGiftPickerOpen(false)}
                title="Select gift products"
                selectedIds={giftProductIds}
                onSelect={(gids) => { setGiftProductIds(gids); saveReward({ variantIds: gids }); }}
              />

              <div className="b-fieldset" style={{ marginTop: 16 }}>
                <p className="b-form-title">Fallback gift if out of stock (optional)</p>
                <p className="b-form-desc">
                  If a gift above sells out, customers get the first fallback that is in stock
                  instead — added automatically for auto-add gifts, or shown in its place in the
                  gift selector. Without a fallback, a sold-out gift is simply not given: no popup
                  appears and no other product is offered.
                </p>
                <div className="b-gift-selector-row" style={{ marginTop: 10 }}>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setFallbackPickerOpen(true)} disabled={!firstReward}>
                    Select fallback gifts
                  </button>
                </div>
                <SelectedProductsList
                  gids={fallbackProductIds}
                  onRemove={(gid) => {
                    const next = fallbackProductIds.filter((id) => id !== gid);
                    setFallbackProductIds(next);
                    saveReward({ fallbackVariantIds: next });
                  }}
                />
                <ProductPicker
                  open={fallbackPickerOpen}
                  onClose={() => setFallbackPickerOpen(false)}
                  title="Select fallback gifts (used in order)"
                  allowMultiple
                  selectedIds={fallbackProductIds}
                  onSelect={(gids) => {
                    const next = gids.slice(0, 5);
                    setFallbackProductIds(next);
                    saveReward({ fallbackVariantIds: next });
                  }}
                />
              </div>
            </div>
          </div>

          {/* Advanced accordion ──────────────────────────── */}
          <div className="b-accordion">
            <button type="button" className="b-accordion-header" onClick={() => setAdvancedOpen(!advancedOpen)}>
              <span className="b-accordion-title">
                <IconInfo />
                Advanced settings (optional)
              </span>
              <span style={{ transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-sub)", display: "flex" }}>
                <IconChevronDown />
              </span>
            </button>
            {advancedOpen && (
              <div className="b-accordion-body">
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div className="b-checkbox-row">
                    <input type="checkbox" id="combine-orders" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} checked={policy?.combinesWithOrderDiscounts ?? false} readOnly />
                    <label htmlFor="combine-orders" className="b-checkbox-label">Combines with order discounts</label>
                  </div>
                  <div className="b-checkbox-row">
                    <input type="checkbox" id="combine-products" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} checked={policy?.combinesWithProductDiscounts ?? false} readOnly />
                    <label htmlFor="combine-products" className="b-checkbox-label">Combines with product discounts</label>
                  </div>
                  <div className="b-checkbox-row">
                    <input type="checkbox" id="combine-shipping" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} checked={policy?.combinesWithShippingDiscounts ?? false} readOnly />
                    <label htmlFor="combine-shipping" className="b-checkbox-label">Combines with shipping discounts</label>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-sub)", margin: 0 }}>
                    To change combination policies, go to the{" "}
                    <Link to={`/app/offers/${offer.id}/combination`} style={{ color: "var(--blue)" }}>Combination settings</Link> page.
                  </p>
                </div>
              </div>
            )}
          </div>

          <CodeNoticeBanners offerId={offer.id} notices={codeNotices} />
          {/* Action feedback banners */}
          {actionData && "error" in actionData && actionData.error && (
            <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
              <span className="b-banner-icon">⚠</span>
              <div className="b-banner-body">
                <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
              </div>
            </div>
          )}
          {actionData && "success" in actionData && actionData.success && (
            <div className="b-banner b-banner-green" style={{ marginBottom: 12 }}>
              <span className="b-banner-icon">✓</span>
              <div className="b-banner-body">
                <p className="b-banner-text" style={{ margin: 0 }}>Saved successfully.</p>
              </div>
            </div>
          )}

          {/* Footer ──────────────────────────────────────── */}
          <div className="b-editor-footer">
            <button type="button" className="b-btn b-btn-secondary" onClick={saveInfo}>
              Save draft
            </button>
            {canPublish ? (
              <button
                type="button"
                className="b-btn b-btn-dark"
                onClick={() => submitAction("publish")}
                disabled={fetcher.state !== "idle"}
              >
                {fetcher.state !== "idle" ? "Publishing…" : "Publish"}
              </button>
            ) : (
              <button type="button" className="b-btn b-btn-danger" onClick={() => submitAction("pause")}>
                Pause offer
              </button>
            )}
          </div>
        </div>

        {/* ── RIGHT SIDEBAR ───────────────────────────────── */}
        <div className="b-editor-sidebar">

          {/* Summary card */}
          <div className="b-card b-card-body">
            <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Summary</p>
            <SummaryItem
              label="Basic information"
              done={hasName}
              details={hasName ? [
                publicTitle || internalName,
                formatStartDate(offer.startsAt),
              ].filter(Boolean) as string[] : undefined}
              onClick={() => scrollToSection("section-offer-info")}
            />
            <SummaryItem
              label="Main condition"
              done={hasConditions}
              details={hasConditions
                ? mainConditions.flatMap((c) => conditionSummary(c.conditionType, c.value as ConditionValue, shopCurrencyCode))
                : undefined}
              onClick={() => { scrollToSection("section-main-condition"); if (!hasConditions) setAddingCondition(true); }}
            />
            <SummaryItem
              label="Subcondition (optional)"
              done={subConditions.length > 0}
              onClick={() => setSubModalOpen(true)}
            />
            <SummaryItem
              label="Gift"
              done={hasRewards}
              details={hasRewards ? [`${rewards.length} reward(s) configured`] : undefined}
              onClick={() => scrollToSection("section-gift-reward")}
            />
          </div>

          {/* Offer metadata */}
          <div className="b-card b-card-body">
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-sub)", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Offer info</p>
            {[
              { label: "Status", value: <span className={`b-badge ${offer.status === "active" ? "b-badge-green" : "b-badge-gray"}`}>{offer.status}</span> },
              { label: "Type", value: offer.type },
              { label: "Created", value: new Date(offer.createdAt).toLocaleDateString() },
              { label: "Updated", value: new Date(offer.updatedAt).toLocaleDateString() },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border-light)" }}>
                <span className="b-text-xs b-text-sub">{item.label}</span>
                <span className="b-text-xs">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
