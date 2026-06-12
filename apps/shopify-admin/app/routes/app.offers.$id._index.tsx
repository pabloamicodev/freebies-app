import { useLoaderData, useNavigate, useFetcher, useActionData, redirect } from "react-router";
import { useState } from "react";
import { SUPPORTED_CURRENCIES } from "@promo/shared-types";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, offerConditions, offerRewards, offerCombinationPolicies, offerVersions } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  IconChevronLeft, IconChevronDown, IconInfo, IconRefresh,
  IconPlus, IconCheck, IconBot, IconLink, IconCondition,
} from "../components/Icons.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { currencyCode: shopCurrencyCode, db } = await getShopContext(request);
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const [conditions, rewards, policy] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
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
  const { session, shopId, currencyCode: shopCurrencyCode, db } = await getShopContext(request);
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

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
      }).where(eq(offers.id, offerId));
      break;
    }
    case "update_condition": {
      const conditionId = formData.get("conditionId") as string;
      const rawValue = formData.get("conditionValue") as string;
      let value: Record<string, unknown> = {};
      try { value = JSON.parse(rawValue); } catch {}
      await db.update(offerConditions).set({ value }).where(eq(offerConditions.id, conditionId));
      break;
    }
    case "delete_condition": {
      const conditionId = formData.get("conditionId") as string;
      await db.delete(offerConditions).where(eq(offerConditions.id, conditionId));
      break;
    }
    case "add_condition": {
      const conditionType = formData.get("conditionType") as string;
      const scope = (formData.get("scope") as "main" | "sub") ?? "main";
      const rawValue = formData.get("conditionValue") as string;
      let value: Record<string, unknown> = {};
      try { value = JSON.parse(rawValue); } catch {}
      const existing = await db.select({ id: offerConditions.id }).from(offerConditions).where(eq(offerConditions.offerId, offerId));
      await db.insert(offerConditions).values({
        shopId, offerId, scope, conditionType,
        operator: "gte", value, sortOrder: existing.length, isEnabled: true,
      });
      break;
    }
    case "update_reward": {
      const rewardId = formData.get("rewardId") as string;
      const quantity = parseInt(formData.get("quantity") as string, 10) || 1;
      const discountType = formData.get("discountType") as string;
      const discountValue = parseFloat(formData.get("discountValue") as string) || 100;
      const isAutoAdd = formData.get("isAutoAdd") === "on";
      await db.update(offerRewards).set({
        discountType: discountType as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
        value: { amount: discountValue, currencyCode: "USD" },
        quantity,
        isAutoAdd,
      }).where(eq(offerRewards.id, rewardId));
      break;
    }
    case "publish": {
      // Guard: must have at least one main condition and one reward
      const [existingConditions, existingRewards] = await Promise.all([
        db.select({ id: offerConditions.id }).from(offerConditions)
          .where(eq(offerConditions.offerId, offerId)),
        db.select({ id: offerRewards.id }).from(offerRewards)
          .where(eq(offerRewards.offerId, offerId)),
      ]);
      if (existingConditions.length === 0) {
        return { error: "Cannot publish: add at least one main condition before publishing." };
      }
      if (existingRewards.length === 0) {
        return { error: "Cannot publish: add at least one reward (gift) before publishing." };
      }

      const now = new Date();
      await db.update(offers).set({ status: "active", updatedAt: now }).where(eq(offers.id, offerId));

      // Write version snapshot
      const offerSnapshot = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
      const condSnapshot = await db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId));
      const rewSnapshot = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId));
      const existingVersions = await db.select({ versionNumber: offerVersions.versionNumber })
        .from(offerVersions).where(eq(offerVersions.offerId, offerId))
        .orderBy(offerVersions.versionNumber);
      const nextVersion = (existingVersions[existingVersions.length - 1]?.versionNumber ?? 0) + 1;
      await db.insert(offerVersions).values({
        shopId,
        offerId,
        versionNumber: nextVersion,
        snapshot: { offer: offerSnapshot[0], conditions: condSnapshot, rewards: rewSnapshot },
        createdBy: session.shop,
      }).onConflictDoNothing();

      try {
        const { offerPublishQueue } = await import("../lib/queues.server.js") as { offerPublishQueue?: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> } };
        if (offerPublishQueue) {
          await offerPublishQueue.add(`publish-${offerId}`, { offerId, shopDomain: session.shop }, { priority: 1 });
        }
      } catch {}
      break;
    }
    case "pause": {
      await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(eq(offers.id, offerId));
      break;
    }
    case "archive": {
      await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, offerId));
      return redirect("/app/offers");
    }
    case "duplicate": {
      const originalRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
      const original = originalRows[0];
      if (!original) break;
      const [newOffer] = await db.insert(offers).values({
        ...original, id: undefined as unknown as string, internalName: `${original.internalName}-copy`,
        status: "draft", createdAt: new Date(), updatedAt: new Date(),
      }).returning({ id: offers.id });
      if (newOffer) return redirect(`/app/offers/${newOffer.id}`);
      break;
    }
  }

  return null;
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
            style={{
              padding: "3px 8px",
              fontSize: 11,
              border: `1px solid ${selected === c ? "var(--blue)" : "var(--border)"}`,
              borderRadius: 4,
              background: selected === c ? "var(--blue-light)" : "transparent",
              color: selected === c ? "var(--blue)" : "var(--text-sub)",
              cursor: "pointer",
              fontWeight: selected === c ? 600 : 400,
            }}
          >
            {c}
          </button>
        ))}
        {!showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{ padding: "3px 8px", fontSize: 11, border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-sub)", cursor: "pointer" }}
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
      <label style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
        Condition applies to:
      </label>
      <select
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
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Saving…</span>
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
                <label style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Min.</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
                  <input
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
                <label style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Max.</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
                  <input
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
            <label style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
              Multiply base value
            </label>
            <div style={{ position: "relative", maxWidth: 200 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13 }}>$</span>
              <input
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
                <label style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Min. quantity</label>
                <input
                  className="b-input"
                  type="number"
                  min="1"
                  value={String(val.minQuantity ?? 1)}
                  onChange={(e) => update({ minQuantity: parseInt(e.target.value, 10) || 1 })}
                  onBlur={() => save()}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "var(--text-sub)", display: "block", marginBottom: 4 }}>Max. quantity (optional)</label>
                <input
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
              <label style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
                Required number of products
              </label>
              <input
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
              <label style={{ fontSize: 13, color: "var(--text)", display: "block", marginBottom: 6 }}>
                The condition applies to:
              </label>
              <select
                className="b-select"
                value="specific_products"
                onChange={() => {}}
                disabled
              >
                <option value="specific_products">products selected</option>
              </select>
            </div>

            <div className="b-gift-selector-row" style={{ marginTop: 0 }}>
              <button type="button" className="b-btn b-btn-secondary b-btn-sm">
                Select products
              </button>
              <span className="b-gift-count-text">
                {Array.isArray(val.variantIds) && (val.variantIds as string[]).length > 0
                  ? `${(val.variantIds as string[]).length} product(s) selected`
                  : "0 products selected"}
              </span>
            </div>
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
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
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
      return new Intl.NumberFormat("en-US", { style: "currency", currency: conditionCurrency, maximumFractionDigits: 2 }).format(cents / 100);
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

  const [internalName, setInternalName] = useState(offer.internalName);
  const [publicTitle, setPublicTitle] = useState(offer.publicTitle ?? "");
  const [startsAt, setStartsAt] = useState(offer.startsAt ? new Date(offer.startsAt).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16));
  const [endsAt, setEndsAt] = useState(offer.endsAt ? new Date(offer.endsAt).toISOString().slice(0, 16) : "");

  const [giftTab, setGiftTab] = useState<"product" | "shipping">("product");
  const firstReward = rewards[0] as typeof rewards[0] | undefined;
  const [discountType, setDiscountType] = useState(firstReward?.discountType ?? "free");
  const [discountValue, setDiscountValue] = useState(
    String((firstReward?.value as { amount?: number } | null)?.amount ?? 100)
  );
  const [receivesAll, setReceivesAll] = useState(firstReward?.isAutoAdd !== false);
  const [giftCount, setGiftCount] = useState(String(firstReward?.quantity ?? 1));

  const [addingCondition, setAddingCondition] = useState(false);
  const [newCondType, setNewCondType] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
      specific_product: { minQtyPerProduct: 1, multiplyGifts: false, giftsMatchProducts: false, trackMode: "product", appliesTo: "specific_products", variantIds: [] },
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
                  <label className="b-label">Start time</label>
                  <input
                    className="b-input"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    onBlur={saveInfo}
                  />
                </div>
                <div>
                  <label className="b-label">End time</label>
                  <input
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
                  <label className="b-label">Condition type</label>
                  <select
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
                  className="b-btn-dark"
                  style={{
                    marginBottom: 10,
                    opacity: mainConditions.length >= 2 ? 0.5 : 1,
                    cursor: mainConditions.length >= 2 ? "not-allowed" : "pointer",
                    display: "inline-flex", alignItems: "center", gap: 6,
                    background: "#111827", color: "white", border: "none",
                    padding: "8px 14px", borderRadius: "var(--r-sm)", fontSize: 14, fontWeight: 500,
                  }}
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
              <div className="b-pill-tabs">
                <button type="button" className={`b-pill-tab${giftTab === "product" ? " active" : ""}`} onClick={() => setGiftTab("product")}>
                  Product gift
                </button>
                <button type="button" className={`b-pill-tab${giftTab === "shipping" ? " active" : ""}`} onClick={() => setGiftTab("shipping")}>
                  Shipping discount as gift
                </button>
              </div>

              {giftTab === "product" && (
                <>
                  <p className="b-text-sm b-text-bold" style={{ marginBottom: 10 }}>Gift discount type</p>
                  <div className="b-discount-type-row">
                    <div>
                      <div className="b-discount-type-label">Type:</div>
                      <select className="b-select" value={discountType} onChange={(e) => setDiscountType(e.target.value as typeof discountType)}>
                        <option value="free">Percentage</option>
                        <option value="percentage">Fixed amount</option>
                      </select>
                    </div>
                    <div>
                      <div className="b-discount-type-label">Value:</div>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-sub)", fontSize: 13, pointerEvents: "none" }}>%</span>
                        <input
                          className="b-input"
                          type="number"
                          value={discountValue}
                          onChange={(e) => setDiscountValue(e.target.value)}
                          style={{ paddingLeft: 26 }}
                          min="0" max="100"
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
                        name="receives"
                        checked={receivesAll}
                        onChange={() => setReceivesAll(true)}
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
                        name="receives"
                        checked={!receivesAll}
                        onChange={() => setReceivesAll(false)}
                        style={{ accentColor: "var(--blue)", width: 15, height: 15, marginTop: 2 }}
                      />
                      <div>
                        <label htmlFor="num-gifts" className="b-checkbox-label">
                          Number of gifts the customer will receive
                        </label>
                        {!receivesAll && (
                          <input
                            className="b-input b-mt-2"
                            type="number"
                            value={giftCount}
                            onChange={(e) => setGiftCount(e.target.value)}
                            min="1"
                            style={{ maxWidth: 120 }}
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="b-gift-selector-row">
                    <button type="button" className="b-btn b-btn-secondary b-btn-sm">Select gifts</button>
                    <span className="b-gift-count-text">
                      {rewards.length > 0 ? `${rewards.length} product(s) configured` : "0 products selected"}
                    </span>
                  </div>
                </>
              )}
              {giftTab === "shipping" && (
                <p className="b-text-sm b-text-sub">Configure a shipping discount as the gift.</p>
              )}
            </div>
          </div>

          {/* Advanced accordion ──────────────────────────── */}
          <div className="b-accordion">
            <div className="b-accordion-header" onClick={() => setAdvancedOpen(!advancedOpen)}>
              <span className="b-accordion-title">
                <IconInfo />
                Advanced settings (optional)
              </span>
              <span style={{ transform: advancedOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", color: "var(--text-sub)", display: "flex" }}>
                <IconChevronDown />
              </span>
            </div>
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

          {/* Publish error banner */}
          {actionData && "error" in actionData && actionData.error && (
            <div className="b-banner b-banner-red" style={{ marginBottom: 12 }}>
              <span className="b-banner-icon">⚠</span>
              <div className="b-banner-body">
                <p className="b-banner-text" style={{ margin: 0 }}>{actionData.error}</p>
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
            <button className="b-btn b-btn-secondary b-w-full">Chat with us</button>
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
            <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub)", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Offer info</p>
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
