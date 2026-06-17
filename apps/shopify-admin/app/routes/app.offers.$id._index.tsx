import { useLoaderData, useNavigate, useFetcher, useActionData, redirect } from "react-router";
import { useState } from "react";
import { SUPPORTED_CURRENCIES, validateConditionValue, validateRewardPayload } from "@promo/shared-types";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { parseJsonRecord, parseJsonStringArray } from "../lib/offer-validation.server.js";
import { normalizeConditionValue } from "../lib/offer-config-normalization.server.js";
import { publishShopConfig, republishIfActive, validateOffersPublishable } from "../lib/offer-publish-flow.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, offerVersions } from "@promo/db";
import { and, eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  IconChevronLeft, IconChevronDown, IconInfo, IconRefresh,
  IconPlus, IconCheck, IconBot, IconLink, IconCondition,
} from "../components/Icons.js";
import { ProductPicker } from "../components/ProductPicker.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, currencyCode: shopCurrencyCode, db } = await getShopContext(request);
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offer = await loadOwnedOffer(db, shopId, offerId);

  const [conditions, rewards, policy] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
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
      const startsAt = formData.get("startsAt") as string;
      const endsAt = formData.get("endsAt") as string;
      await db.update(offers).set({
        publicTitle, internalName,
        startsAt: startsAt ? new Date(startsAt) : null,
        endsAt: endsAt ? new Date(endsAt) : null,
        updatedAt: new Date(),
      }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
      if (publishError) return { error: publishError };
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
      const conditionType = formData.get("conditionType") as string;
      const scope = (formData.get("scope") as "main" | "sub") ?? "main";
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
        set["target"] = { scope: "cart", variantIds };
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

      // Persist status, publish synchronously, and rollback status if Shopify
      // rejects the compiled config. The admin must not report "active" for a
      // config that the storefront cannot read.
      const now = new Date();
      await db.update(offers).set({ status: "active", updatedAt: now }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
      const validation = await validateOffersPublishable(db, shopId, [offerId]);
      if (!validation.ok) return { error: validation.error };
      const publishError = await publishShopConfig(shopId, session.shop);
      if (publishError) {
        await db.update(offers).set({ status: offer.status, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
        return { error: publishError };
      }

      const [offerSnapshot, condSnapshot, rewSnapshot, policySnapshot, existingVersions] = await Promise.all([
        db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1),
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
        db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
        db.select({ versionNumber: offerVersions.versionNumber })
          .from(offerVersions).where(and(eq(offerVersions.shopId, shopId), eq(offerVersions.offerId, offerId)))
          .orderBy(offerVersions.versionNumber),
      ]);
      const nextVersion = (existingVersions[existingVersions.length - 1]?.versionNumber ?? 0) + 1;
      await db.insert(offerVersions).values({
        shopId,
        offerId,
        versionNumber: nextVersion,
        snapshot: { offer: offerSnapshot[0], conditions: condSnapshot, rewards: rewSnapshot, combinationPolicy: policySnapshot[0] ?? null },
        createdBy: session.shop,
      }).onConflictDoNothing();

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
      return redirect("/app/offers");
    }
    case "duplicate": {
      const [newOffer] = await db.insert(offers).values({
        ...offer, id: undefined as unknown as string, internalName: `${offer.internalName}-copy`,
        status: "draft", createdAt: new Date(), updatedAt: new Date(),
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
};

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

function ConditionCard({
  conditionId,
  conditionType,
  initialValue,
  onDelete,
}: {
  conditionId: string;
  conditionType: string;
  initialValue: ConditionValue;
  onDelete: () => void;
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "end" }}>
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
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
              <span className="b-gift-count-text">
                {selectedVariantIds.length > 0
                  ? `${selectedVariantIds.length} product(s) selected`
                  : "0 products selected"}
              </span>
            </div>

            <ProductPicker
              open={productPickerOpen}
              onClose={() => setProductPickerOpen(false)}
              title="Select condition products"
              selectedIds={selectedVariantIds}
              onSelect={(gids) => { const next = { ...val, variantIds: gids }; setVal(next); save(next); }}
            />
          </>
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
}: {
  label: string;
  done: boolean;
  details?: string[];
}) {
  return (
    <div className="b-summary-item">
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
  const { offer, conditions, rewards, policy, shopCurrencyCode } = useLoaderData<typeof loader>();
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

  // Persist the reward (discount type/value/qty/auto-add + product target).
  // The editor previously never submitted update_reward, so gift edits were lost.
  // Accepts explicit overrides so callers that also setState don't read a stale closure.
  function saveReward(overrides?: {
    discountType?: string;
    discountValue?: string;
    giftCount?: string;
    receivesAll?: boolean;
    variantIds?: string[];
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
    void fetcher.submit(fd, { method: "POST" });
  }

  const canPublish = offer.status === "draft" || offer.status === "paused";
  const hasName = Boolean(internalName.trim());
  const hasConditions = conditions.length > 0;
  const hasRewards = rewards.length > 0;

  const mainConditions = conditions.filter((c) => c.scope === "main");
  const subConditions = conditions.filter((c) => c.scope === "sub");

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
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/conditions`)}>Conditions</button>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/rewards`)}>Rewards</button>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/combination`)}>Combination</button>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/schedule`)}>Schedule</button>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/widget`)}>Widgets</button>
                  <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => navigate(`/app/offers/${offer.id}/preview`)}>Preview</button>
                </div>
                <div className="b-stack b-stack-3">
                  <div className="b-card">
                    <div className="b-card-header">Conditions</div>
                    <div className="b-card-body">
                      {conditions.length > 0 ? conditions.map((condition) => (
                        <p key={condition.id} className="b-text-sm" style={{ margin: "0 0 6px" }}>
                          {CONDITION_TYPE_NAMES[condition.conditionType] ?? condition.conditionType}
                        </p>
                      )) : <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>No conditions configured.</p>}
                    </div>
                  </div>
                  <div className="b-card">
                    <div className="b-card-header">Rewards</div>
                    <div className="b-card-body">
                      {rewards.length > 0 ? rewards.map((reward) => (
                        <p key={reward.id} className="b-text-sm" style={{ margin: "0 0 6px" }}>
                          {reward.rewardType} - {reward.discountType}
                        </p>
                      )) : <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>No rewards configured.</p>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

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

          <div className="b-editor-side">
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
          Create gift offer
        </button>
      </div>

      <div className="b-editor-layout">
        {/* ── LEFT COLUMN ─────────────────────────────────── */}
        <div className="b-editor-main">

          {/* Offer info ──────────────────────────────────── */}
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
          <div className="b-editor-section">
            <p className="b-editor-section-title">Offer main condition</p>
            <div className="b-editor-section-body">
              {mainConditions.map((c) => (
                <ConditionCard
                  key={c.id}
                  conditionId={c.id}
                  conditionType={c.conditionType}
                  initialValue={c.value as ConditionValue}
                  onDelete={() => deleteCondition(c.id)}
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
          <div
            className="b-subcondition-row"
            style={{ cursor: "default" }}
          >
            <IconRefresh />
            <span style={{ fontSize: 14, color: "var(--text-sub)" }}>
              {subConditions.length > 0
                ? `${subConditions.length} subcondition(s) configured`
                : "Add subcondition (optional)"}
            </span>
          </div>

          {/* Select gifts ────────────────────────────────── */}
          <div className="b-editor-section">
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
                <div className="b-checkbox-row" style={{ alignItems: "flex-start" }}>
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
                        className="b-input b-mt-2"
                        type="number"
                        value={giftCount}
                        onChange={(e) => setGiftCount(e.target.value)}
                        onBlur={() => saveReward()}
                        min="1"
                        style={{ maxWidth: 120 }}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="b-gift-selector-row">
                <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setGiftPickerOpen(true)} disabled={!firstReward}>Select gifts</button>
                <span className="b-gift-count-text">
                  {giftProductIds.length > 0 ? `${giftProductIds.length} product(s) selected` : "0 products selected"}
                </span>
              </div>

              <ProductPicker
                open={giftPickerOpen}
                onClose={() => setGiftPickerOpen(false)}
                title="Select gift products"
                selectedIds={giftProductIds}
                onSelect={(gids) => { setGiftProductIds(gids); saveReward({ variantIds: gids }); }}
              />
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
                    <input type="checkbox" id="combine-orders" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} defaultChecked={policy?.combinesWithOrderDiscounts ?? false} />
                    <label htmlFor="combine-orders" className="b-checkbox-label">Combines with order discounts</label>
                  </div>
                  <div className="b-checkbox-row">
                    <input type="checkbox" id="combine-products" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} defaultChecked={policy?.combinesWithProductDiscounts ?? false} />
                    <label htmlFor="combine-products" className="b-checkbox-label">Combines with product discounts</label>
                  </div>
                  <div className="b-checkbox-row">
                    <input type="checkbox" id="combine-shipping" style={{ accentColor: "var(--blue)", width: 15, height: 15 }} defaultChecked={policy?.combinesWithShippingDiscounts ?? false} />
                    <label htmlFor="combine-shipping" className="b-checkbox-label">Combines with shipping discounts</label>
                  </div>
                </div>
              </div>
            )}
          </div>

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

          {/* Support card */}
          <div className="b-card b-card-body" style={{ textAlign: "center" }}>
            <div className="b-support-bot-icon" style={{ margin: "0 auto 10px" }}><IconBot /></div>
            <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 6px" }}>Need help creating offers?</p>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "0 0 14px" }}>Chat with us to get help</p>
            <button type="button" className="b-btn b-btn-secondary b-w-full">Chat with us</button>
          </div>

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
            />
            <SummaryItem
              label="Main condition"
              done={hasConditions}
              details={hasConditions
                ? mainConditions.flatMap((c) => conditionSummary(c.conditionType, c.value as ConditionValue, shopCurrencyCode))
                : undefined}
            />
            <SummaryItem
              label="Subcondition (optional)"
              done={subConditions.length > 0}
            />
            <SummaryItem
              label="Gift"
              done={hasRewards}
              details={hasRewards ? [`${rewards.length} reward(s) configured`] : undefined}
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
