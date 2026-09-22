/**
 * Offer Rewards Editor — Step 4 of the offer builder wizard.
 * Configure what the customer receives: gift products, discounts, shipping.
 */

import { useLoaderData, useNavigate, useNavigation, useActionData, Form } from "react-router";
import { NotFound } from "../components/NotFound.js";
export { RouteErrorBoundary as ErrorBoundary } from "../components/RouteErrorBoundary.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { insertAuditLog } from "../lib/audit-log.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offerRewards } from "@promo/db";
import {
  DeliveryGroupTypeSchema,
  DiscountTypeSchema,
  RewardTypeSchema,
  ShippingDiscountTierSchema,
  validateRewardPayload,
  type DeliveryGroupType,
  type ShippingDiscountTier,
} from "@promo/shared-types";
import { and, eq } from "drizzle-orm";
import { republishIfActive } from "../lib/offer-publish-flow.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

function splitTextareaList(value: string | null): string[] {
  return (value ?? "").split("\n").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function parseShippingTiers(value: FormDataEntryValue | null):
  | { tiers: ShippingDiscountTier[]; error?: never }
  | { tiers?: never; error: string } {
  if (typeof value !== "string") return { error: "Configure at least one shipping tier." };
  try {
    const result = ShippingDiscountTierSchema.array().min(1).safeParse(JSON.parse(value));
    if (!result.success) {
      return { error: result.error.issues[0]?.message ?? "Shipping tiers are invalid." };
    }
    return { tiers: result.data };
  } catch {
    return { error: "Shipping tiers must be valid JSON." };
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const rewardRows = await db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));

  return {
    offer,
    rewards: rewardRows.sort((a, b) => a.sortOrder - b.sortOrder),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  if (intent === "add_reward") {
    const rewardType = formData.get("rewardType") as string;
    let discountType = formData.get("discountType") as string;
    let shippingTiers: ShippingDiscountTier[] | null = null;
    if (rewardType === "shipping_discount") {
      const parsedTiers = parseShippingTiers(formData.get("shippingTiers"));
      if ("error" in parsedTiers) return { error: parsedTiers.error };
      shippingTiers = parsedTiers.tiers;
      discountType = shippingTiers[0]!.discountType;
    }
    const rewardTypeResult = RewardTypeSchema.safeParse(rewardType);
    if (!rewardTypeResult.success) return { error: "Reward type is invalid." };
    const discountTypeResult = DiscountTypeSchema.safeParse(discountType);
    if (!discountTypeResult.success) return { error: "Discount type is invalid." };
    const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
    const quantityRaw = formData.get("quantity");
    const quantity = quantityRaw ? parseInt(quantityRaw as string, 10) : null;
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 1)) {
      return { error: "Quantity must be at least 1." };
    }
    const isAutoAdd = formData.get("isAutoAdd") === "on";
    const isCustomerSelectable = formData.get("isCustomerSelectable") === "on";
    const trackMode = (formData.get("trackMode") as "product" | "variant") ?? "product";
    const label = (formData.get("label") as string) || null;
    const currencyCode = (formData.get("currencyCode") as string) || "USD";

    if (!rewardType) return { error: "Reward type is required." };

    const needsValue = rewardType !== "shipping_discount" && discountType !== "free" && discountType !== "cheapest_item_free" && discountType !== "most_expensive_item_discount";
    if (needsValue && discountValue <= 0) {
      return { error: "Discount value must be greater than 0." };
    }
    if (discountType === "percentage" && discountValue > 100) {
      return { error: "Percentage discount cannot exceed 100%." };
    }

    // Build target from variant GIDs — merge picker selection with manual textarea input.
    const pickerGids = splitTextareaList(formData.get("variantGids") as string | null);
    const manualGids = splitTextareaList(formData.get("variantGidsManual") as string | null);
    const variantGids = [...new Set([...pickerGids, ...manualGids])];

    let target: Record<string, unknown>;
    let value: Record<string, unknown>;
    if (rewardType === "shipping_discount") {
      const groupTypesResult = DeliveryGroupTypeSchema.array().min(1).safeParse(
        formData.getAll("deliveryGroupTypes"),
      );
      if (!groupTypesResult.success) {
        return { error: "Choose at least one delivery group type." };
      }
      const scopeMode = formData.get("shippingScopeMode");
      if (scopeMode !== "sitewide" && scopeMode !== "landing" && scopeMode !== "quiz_bundle") {
        return { error: "Shipping scope is invalid." };
      }
      const requiredAnchorMinQuantity = Number(formData.get("requiredAnchorMinQuantity") ?? 1);
      target = {
        deliveryGroupTypes: groupTypesResult.data,
        scopeMode,
        ...(scopeMode === "landing"
          ? {
              requiredLineAttributeKey: "__landing_source",
              requiredLineAttributeValue: String(formData.get("requiredLineAttributeValue") ?? "").trim(),
              requiredAnchorVariantIds: splitTextareaList(formData.get("requiredAnchorVariantIds") as string | null),
              requiredAnchorMinQuantity,
              requiresAnchorSubscription: formData.get("requiresAnchorSubscription") === "on",
            }
          : {}),
      };
      value = {
        amount: shippingTiers![0]!.discountValue,
        currencyCode,
        tiers: shippingTiers,
      };
    } else {
      target = variantGids.length > 0
        ? { variantIds: variantGids }
        : { scope: "cart" };
      if (rewardType === "product_discount") {
        const lineQuantityEqualsRaw = Number(formData.get("lineQuantityEquals") ?? 0);
        const maxUnitsTotalRaw = Number(formData.get("maxUnitsTotal") ?? 0);
        const subscriptionMode = formData.get("subscriptionMode");
        const productScopeMode = formData.get("productScopeMode");
        if (productScopeMode !== "sitewide" && productScopeMode !== "landing" && productScopeMode !== "quiz_bundle") {
          return { error: "Product discount scope is invalid." };
        }
        let priceTiers: Array<{ quantity: number; targetPricePerUnit: number }> = [];
        const priceTiersRaw = formData.get("productPriceTiers");
        if (typeof priceTiersRaw === "string" && priceTiersRaw) {
          try {
            const parsed = JSON.parse(priceTiersRaw) as unknown;
            if (!Array.isArray(parsed)) return { error: "Product price tiers are invalid." };
            priceTiers = parsed.flatMap((tier) => {
              if (!tier || typeof tier !== "object") return [];
              const candidate = tier as Record<string, unknown>;
              const tierQuantity = Number(candidate["quantity"]);
              const targetPricePerUnit = Number(candidate["targetPricePerUnit"]);
              return Number.isInteger(tierQuantity) && tierQuantity > 0 && Number.isFinite(targetPricePerUnit) && targetPricePerUnit >= 0
                ? [{ quantity: tierQuantity, targetPricePerUnit }]
                : [];
            });
          } catch {
            return { error: "Product price tiers must be valid JSON." };
          }
        }
        const ordinaryTarget = {
          ...target,
          ...(Number.isInteger(lineQuantityEqualsRaw) && lineQuantityEqualsRaw > 0
            ? { lineQuantityEquals: lineQuantityEqualsRaw }
            : {}),
          ...(Number.isInteger(maxUnitsTotalRaw) && maxUnitsTotalRaw > 0
            ? { maxUnitsTotal: maxUnitsTotalRaw }
            : {}),
          subscriptionMode:
            subscriptionMode === "subscription_only" || subscriptionMode === "one_time_only"
              ? subscriptionMode
              : "any",
          scopeMode: productScopeMode,
          ...(productScopeMode === "landing"
            ? {
                requiredLineAttributeKey: "__landing_source",
                requiredLineAttributeValue: String(formData.get("requiredLineAttributeValue") ?? "").trim(),
                requiredAnchorVariantIds: splitTextareaList(formData.get("requiredAnchorVariantIds") as string | null),
                requiredAnchorMinQuantity: Math.max(1, Number(formData.get("requiredAnchorMinQuantity") ?? 1)),
                requiresAnchorSubscription: formData.get("requiresAnchorSubscription") === "on",
                ...(priceTiers.length ? { priceTiers } : {}),
              }
            : {}),
        };
        target = productScopeMode === "quiz_bundle"
          ? {
              scopeMode: "quiz_bundle",
              scope: "cart",
              discountPercentageOnGifts: Math.min(100, Math.max(0, Number(formData.get("discountPercentageOnGifts") ?? 100))),
            }
          : ordinaryTarget;
      }
      value = {
        amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100),
        currencyCode,
      };
    }
    const payloadResult = validateRewardPayload(rewardType, discountType, value, target);
    if (!payloadResult.success) return { error: payloadResult.error.issues[0]?.message ?? "Reward configuration is invalid." };

    const existing = await db.select({ id: offerRewards.id })
      .from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));

    await db.insert(offerRewards).values({
      shopId, offerId,
      rewardType: rewardTypeResult.data,
      discountType: discountTypeResult.data,
      value,
      target,
      quantity,
      isAutoAdd,
      isCustomerSelectable,
      trackMode,
      sortOrder: existing.length,
      label,
    });
    const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
    if (publishError) return { error: publishError };
    void insertAuditLog(db, { shopId, entityType: "offer_reward", entityId: offerId, action: "add_reward", after: { rewardType, discountType }, performedBy: session.shop });
  }

  if (intent === "delete_reward") {
    const rewardId = formData.get("rewardId") as string;
    if (!rewardId) return { error: "Reward ID missing." };
    if (offer.status === "active") {
      const rewards = await db.select({ id: offerRewards.id })
        .from(offerRewards)
        .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
      if (rewards.length <= 1) {
        return { error: "Cannot delete the last reward from an active offer. Pause it first or add another reward." };
      }
    }
    await db.delete(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, rewardId)));
    const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
    if (publishError) return { error: publishError };
    void insertAuditLog(db, { shopId, entityType: "offer_reward", entityId: rewardId, action: "delete_reward", before: { offerId }, performedBy: session.shop });
  }

  return { success: true };
};

const REWARD_TYPES = [
  { label: "Product Gift — add a free or discounted product", value: "product_gift" },
  { label: "Order Discount — % or $ off the cart total", value: "order_discount" },
  { label: "Shipping Discount — % or $ off shipping", value: "shipping_discount" },
  { label: "Product Discount — % or $ off specific products", value: "product_discount" },
];

const DISCOUNT_TYPES = [
  { label: "Free (100% off)", value: "free" },
  { label: "Percentage off", value: "percentage" },
  { label: "Fixed amount off", value: "fixed_amount" },
  { label: "Fixed price", value: "fixed_price" },
  { label: "Cheapest item free", value: "cheapest_item_free" },
  { label: "Most expensive item discount", value: "most_expensive_item_discount" },
];

const REWARD_TYPE_LABELS: Record<string, string> = {
  product_gift: "Gift",
  order_discount: "Order",
  shipping_discount: "Shipping",
  product_discount: "Product",
};

interface ShippingTierDraft {
  key: string;
  minimumSubtotal: string;
  discountType: "percentage" | "fixed_amount";
  discountValue: string;
  appliesWhen: "" | "has_subscription" | "one_time_only";
}

interface ProductPriceTierDraft {
  key: string;
  quantity: string;
  targetPricePerUnit: string;
}

const DEFAULT_SHIPPING_TIER: ShippingTierDraft = {
  key: "shipping-tier-1",
  minimumSubtotal: "0",
  discountType: "percentage",
  discountValue: "100",
  appliesWhen: "",
};

export default function OfferRewardsPage() {
  const { offer, rewards } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const isSubmitting = navigation.state !== "idle";
  const [rewardState, setRewardField] = useObjectState({
    adding: false,
    rewardType: "product_gift",
    discountType: "free",
    pickerOpen: false,
    selectedGiftGids: [] as string[],
    currencyCode: "USD",
    giftQuantity: "1",
    shippingTiers: [{ ...DEFAULT_SHIPPING_TIER }],
    deliveryGroupTypes: ["ONE_TIME_PURCHASE", "SUBSCRIPTION"] as DeliveryGroupType[],
    shippingScopeMode: "sitewide" as "sitewide" | "landing" | "quiz_bundle",
    requiredLineAttributeValue: "",
    requiredAnchorVariantIds: "",
    requiredAnchorMinQuantity: "1",
    requiresAnchorSubscription: false,
    productScopeMode: "sitewide" as "sitewide" | "landing" | "quiz_bundle",
    productPriceTiers: [{ key: "product-tier-1", quantity: "1", targetPricePerUnit: "" }] as ProductPriceTierDraft[],
  });
  const {
    adding,
    rewardType,
    discountType,
    pickerOpen,
    selectedGiftGids,
    currencyCode,
    giftQuantity,
    shippingTiers,
    deliveryGroupTypes,
    shippingScopeMode,
    requiredLineAttributeValue,
    requiredAnchorVariantIds,
    requiredAnchorMinQuantity,
    requiresAnchorSubscription,
    productScopeMode,
    productPriceTiers,
  } = rewardState;
  const setAdding = createFieldSetter(setRewardField, "adding");
  const setRewardType = createFieldSetter(setRewardField, "rewardType");
  const setDiscountType = createFieldSetter(setRewardField, "discountType");
  const setPickerOpen = createFieldSetter(setRewardField, "pickerOpen");
  const setSelectedGiftGids = createFieldSetter(setRewardField, "selectedGiftGids");
  const setCurrencyCode = createFieldSetter(setRewardField, "currencyCode");
  const setGiftQuantity = createFieldSetter(setRewardField, "giftQuantity");
  const setShippingTiers = createFieldSetter(setRewardField, "shippingTiers");
  const setDeliveryGroupTypes = createFieldSetter(setRewardField, "deliveryGroupTypes");
  const setShippingScopeMode = createFieldSetter(setRewardField, "shippingScopeMode");
  const setRequiredLineAttributeValue = createFieldSetter(setRewardField, "requiredLineAttributeValue");
  const setRequiredAnchorVariantIds = createFieldSetter(setRewardField, "requiredAnchorVariantIds");
  const setRequiredAnchorMinQuantity = createFieldSetter(setRewardField, "requiredAnchorMinQuantity");
  const setRequiresAnchorSubscription = createFieldSetter(setRewardField, "requiresAnchorSubscription");
  const setProductScopeMode = createFieldSetter(setRewardField, "productScopeMode");
  const setProductPriceTiers = createFieldSetter(setRewardField, "productPriceTiers");

  if (!offer) return <NotFound message="Offer not found." />;

  const needsValue =
    rewardType !== "shipping_discount" &&
    discountType !== "free" &&
    discountType !== "cheapest_item_free" &&
    discountType !== "most_expensive_item_discount";

  function updateShippingTier(
    index: number,
    field: Exclude<keyof ShippingTierDraft, "key">,
    value: string,
  ) {
    setShippingTiers((current) =>
      current.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier,
      ),
    );
  }

  function toggleDeliveryGroupType(groupType: DeliveryGroupType) {
    setDeliveryGroupTypes((current) =>
      current.includes(groupType)
        ? current.filter((value) => value !== groupType)
        : [...current, groupType],
    );
  }

  const serializedShippingTiers = JSON.stringify(
    shippingTiers.map((tier) => ({
      minimumSubtotalCents: Math.round(Number(tier.minimumSubtotal || 0) * 100),
      discountType: tier.discountType,
      discountValue: Number(tier.discountValue || 0),
      ...(tier.appliesWhen ? { appliesWhen: tier.appliesWhen } : {}),
    })),
  );
  const serializedProductPriceTiers = JSON.stringify(
    productPriceTiers.flatMap((tier) => {
      const quantity = Number(tier.quantity);
      const targetPricePerUnit = Number(tier.targetPricePerUnit);
      return Number.isInteger(quantity) && quantity > 0 && Number.isFinite(targetPricePerUnit) && targetPricePerUnit >= 0
        ? [{ quantity, targetPricePerUnit }]
        : [];
    }),
  );

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={rewardType === "product_discount" ? "Select Discounted Variants" : "Select Gift Products"}
        mode="variants"
        allowMultiple
        selectedIds={selectedGiftGids}
        onSelect={setSelectedGiftGids}
      />

      <div className="b-page">
        {/* ── Page header ─────────────────────────────────── */}
        <PageHeader
          title="Rewards / Gifts"
          subtitle={offer.internalName}
          backTo={`/app/offers/${offer.id}/conditions`}
          actions={<button type="button" className="b-btn b-btn-primary" onClick={() => navigate(`/app/offers/${offer.id}`)}>Widget →</button>}
        />

        {/* ── Action feedback banners ─────────────────────── */}
        {"error" in (actionData ?? {}) && (actionData as { error: string }).error && (
          <div className="b-banner b-banner-red b-mb-4">
            <span className="b-banner-icon">✕</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>
                {(actionData as { error: string }).error}
              </p>
            </div>
          </div>
        )}
        {"success" in (actionData ?? {}) && (actionData as { success: boolean }).success && (
          <div className="b-banner b-banner-green b-mb-4">
            <span className="b-banner-icon">✓</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>Saved successfully.</p>
            </div>
          </div>
        )}

        {/* ── No rewards warning ───────────────────────────── */}
        {rewards.length === 0 && !adding && (
          <div className="b-banner b-banner-orange b-mb-4">
            <span className="b-banner-icon">⚠️</span>
            <div className="b-banner-body">
              <p className="b-banner-title">No rewards configured</p>
              <p className="b-banner-text">
                Add at least one reward before publishing this offer.
              </p>
            </div>
          </div>
        )}

        {/* ── Rewards list ─────────────────────────────────── */}
        <div className="b-card">
          <div className="b-card-header">Rewards</div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">
              {rewards.map((r) => (
                <div
                  key={r.id}
                  className="b-row-between"
                  style={{
                    padding: "14px 16px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r)",
                    background: "var(--bg-hover)",
                  }}
                >
                  {/* Left: badges + info */}
                  <div className="b-row b-gap-3" style={{ flexWrap: "wrap" }}>
                    <span className="b-badge b-badge-green">
                      {REWARD_TYPE_LABELS[r.rewardType] ?? r.rewardType}
                    </span>
                    <span className="b-text-sm b-text-bold">{r.discountType}</span>
                    {r.quantity != null && (
                      <span className="b-text-sm b-text-sub">Qty: {r.quantity}</span>
                    )}
                    {r.isAutoAdd && (
                      <span className="b-badge b-badge-blue">Auto-add</span>
                    )}
                    {r.isCustomerSelectable && (
                      <span className="b-badge b-badge-orange">Customer selects</span>
                    )}
                  </div>

                  {/* Right: delete button */}
                  <Form method="POST" style={{ flexShrink: 0, marginLeft: 16 }}
                    onSubmit={(e) => { if (!window.confirm("Remove this reward?")) e.preventDefault(); }}>
                    <input type="hidden" name="intent" value="delete_reward" />
                    <input type="hidden" name="rewardId" value={r.id} />
                    <button
                      type="submit"
                      className="b-btn-icon b-btn-icon-red"
                      title="Remove reward"
                    >
                      ✕
                    </button>
                  </Form>
                </div>
              ))}

              {rewards.length === 0 && (
                <p className="b-text-sm b-text-muted" style={{ margin: 0 }}>
                  No rewards yet.
                </p>
              )}
            </div>

            {!adding && (
              <button
                type="button"
                className="b-btn b-btn-secondary b-mt-4"
                onClick={() => setAdding(true)}
              >
                + Add Reward
              </button>
            )}
          </div>
        </div>

        {/* ── Add reward form ──────────────────────────────── */}
        {adding && (
          <div className="b-card b-mt-4">
            <div className="b-card-header">Add Reward</div>
            <div className="b-card-body">
              <Form method="POST">
                <input type="hidden" name="intent" value="add_reward" />

                <div className="b-stack b-stack-3">
                  {/* Reward type */}
                  <div>
                    <label className="b-label" htmlFor="rewardType">
                      Reward Type
                    </label>
                    <select
                      id="rewardType"
                      name="rewardType"
                      className="b-select"
                      value={rewardType}
                      onChange={(e) => setRewardType(e.target.value)}
                    >
                      {REWARD_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Discount type */}
                  {rewardType === "shipping_discount" ? (
                    <input
                      type="hidden"
                      name="discountType"
                      value={shippingTiers[0]?.discountType ?? "percentage"}
                    />
                  ) : (
                    <div>
                      <label className="b-label" htmlFor="discountType">
                        Discount Type
                      </label>
                      <select
                        id="discountType"
                        name="discountType"
                        className="b-select"
                        value={discountType}
                        onChange={(e) => setDiscountType(e.target.value)}
                      >
                        {DISCOUNT_TYPES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Discount value + currency (only when applicable) */}
                  {needsValue && (
                    <div className="b-grid-2">
                      <div>
                        <label className="b-label" htmlFor="discountValue">
                          Discount Value{" "}
                          <span className="b-text-muted">
                            ({discountType === "percentage" ? "%" : "$"})
                          </span>
                        </label>
                        <input
                          id="discountValue"
                          name="discountValue"
                          type="number"
                          className="b-input"
                          min="0.01"
                          step="0.01"
                          required
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="currencyCode">
                          Currency Code
                        </label>
                        <input
                          id="currencyCode"
                          name="currencyCode"
                          type="text"
                          className="b-input"
                          value={currencyCode}
                          onChange={(e) => setCurrencyCode(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}

                  {/* Hidden discount value for fixed/free types */}
                  {rewardType !== "shipping_discount" && (discountType === "free" || discountType === "cheapest_item_free") && (
                    <input type="hidden" name="discountValue" value="100" />
                  )}
                  {rewardType !== "shipping_discount" && discountType === "most_expensive_item_discount" && (
                    <input type="hidden" name="discountValue" value="0" />
                  )}

                  {rewardType === "shipping_discount" && (
                    <>
                      <input type="hidden" name="discountValue" value="0" />
                      <input type="hidden" name="shippingTiers" value={serializedShippingTiers} />
                      <hr className="b-divider" />

                      <div>
                        <label className="b-label" htmlFor="shippingScopeMode">
                          Qualification scope
                        </label>
                        <select
                          id="shippingScopeMode"
                          name="shippingScopeMode"
                          className="b-select"
                          value={shippingScopeMode}
                          onChange={(event) => setShippingScopeMode(event.target.value as typeof shippingScopeMode)}
                        >
                          <option value="sitewide">Sitewide subtotal tiers</option>
                          <option value="landing">Landing page line property</option>
                          <option value="quiz_bundle">Complete quiz bundle</option>
                        </select>
                        <p className="b-help">
                          Scoped landing and quiz offers take precedence over sitewide shipping offers.
                        </p>
                      </div>

                      {shippingScopeMode === "landing" && (
                        <div className="b-card" style={{ padding: 16, margin: 0 }}>
                          <div className="b-grid-2">
                            <div>
                              <label className="b-label" htmlFor="requiredLineAttributeKey">
                                Line property
                              </label>
                              <input
                                id="requiredLineAttributeKey"
                                className="b-input"
                                value="__landing_source"
                                readOnly
                              />
                            </div>
                            <div>
                              <label className="b-label" htmlFor="requiredLineAttributeValue">
                                Required value
                              </label>
                              <input
                                id="requiredLineAttributeValue"
                                name="requiredLineAttributeValue"
                                className="b-input"
                                value={requiredLineAttributeValue}
                                onChange={(event) => setRequiredLineAttributeValue(event.target.value)}
                                required
                                autoComplete="off"
                              />
                            </div>
                            <div>
                              <label className="b-label" htmlFor="requiredAnchorVariantIds">
                                Anchor variant GIDs
                              </label>
                              <textarea
                                id="requiredAnchorVariantIds"
                                name="requiredAnchorVariantIds"
                                className="b-input"
                                rows={3}
                                value={requiredAnchorVariantIds}
                                onChange={(event) => setRequiredAnchorVariantIds(event.target.value)}
                                placeholder="Optional, one ProductVariant GID per line"
                                style={{ resize: "vertical" }}
                              />
                            </div>
                            <div>
                              <label className="b-label" htmlFor="requiredAnchorMinQuantity">
                                Minimum anchor quantity
                              </label>
                              <input
                                id="requiredAnchorMinQuantity"
                                name="requiredAnchorMinQuantity"
                                type="number"
                                className="b-input"
                                min="1"
                                step="1"
                                value={requiredAnchorMinQuantity}
                                onChange={(event) => setRequiredAnchorMinQuantity(event.target.value)}
                                required
                                autoComplete="off"
                              />
                            </div>
                          </div>
                          <label className="b-checkbox-row b-mt-3">
                            <input
                              type="checkbox"
                              name="requiresAnchorSubscription"
                              checked={requiresAnchorSubscription}
                              onChange={(event) => setRequiresAnchorSubscription(event.target.checked)}
                            />
                            <span className="b-checkbox-label">Require the anchor line to be a subscription</span>
                          </label>
                        </div>
                      )}

                      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="b-label">Eligible delivery groups</legend>
                        <div className="b-row b-gap-3" style={{ flexWrap: "wrap" }}>
                          {(["ONE_TIME_PURCHASE", "SUBSCRIPTION"] as const).map((groupType) => (
                            <label className="b-checkbox-row" key={groupType}>
                              <input
                                type="checkbox"
                                name="deliveryGroupTypes"
                                value={groupType}
                                checked={deliveryGroupTypes.includes(groupType)}
                                onChange={() => toggleDeliveryGroupType(groupType)}
                              />
                              <span className="b-checkbox-label">
                                {groupType === "ONE_TIME_PURCHASE" ? "One-time purchase" : "Subscription"}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div>
                        <label className="b-label" htmlFor="shippingCurrencyCode">
                          Currency code
                        </label>
                        <input
                          id="shippingCurrencyCode"
                          name="currencyCode"
                          type="text"
                          className="b-input"
                          value={currencyCode}
                          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())}
                          minLength={3}
                          maxLength={3}
                          required
                          autoComplete="off"
                        />
                      </div>

                      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="b-label">Shipping discount tiers</legend>
                        <p className="b-help">
                          The highest qualifying subtotal tier wins. Subscription-specific tiers take precedence when the cart contains a subscription.
                        </p>
                        <div className="b-stack b-stack-3">
                          {shippingTiers.map((tier, index) => (
                            <div
                              key={tier.key}
                              className="b-card"
                              style={{ padding: 16, margin: 0 }}
                            >
                              <div className="b-grid-2">
                                <div>
                                  <label className="b-label" htmlFor={`shipping-minimum-${index}`}>
                                    Minimum subtotal
                                  </label>
                                  <input
                                    id={`shipping-minimum-${index}`}
                                    type="number"
                                    className="b-input"
                                    min="0"
                                    step="0.01"
                                    value={tier.minimumSubtotal}
                                    onChange={(event) => updateShippingTier(index, "minimumSubtotal", event.target.value)}
                                    required
                                    autoComplete="off"
                                  />
                                </div>
                                <div>
                                  <label className="b-label" htmlFor={`shipping-type-${index}`}>
                                    Discount type
                                  </label>
                                  <select
                                    id={`shipping-type-${index}`}
                                    className="b-select"
                                    value={tier.discountType}
                                    onChange={(event) => updateShippingTier(index, "discountType", event.target.value)}
                                  >
                                    <option value="percentage">Percentage</option>
                                    <option value="fixed_amount">Fixed amount</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="b-label" htmlFor={`shipping-value-${index}`}>
                                    Discount value {tier.discountType === "percentage" ? "(%)" : `(${currencyCode})`}
                                  </label>
                                  <input
                                    id={`shipping-value-${index}`}
                                    type="number"
                                    className="b-input"
                                    min="0.01"
                                    max={tier.discountType === "percentage" ? "100" : undefined}
                                    step="0.01"
                                    value={tier.discountValue}
                                    onChange={(event) => updateShippingTier(index, "discountValue", event.target.value)}
                                    required
                                    autoComplete="off"
                                  />
                                </div>
                                <div>
                                  <label className="b-label" htmlFor={`shipping-condition-${index}`}>
                                    Cart composition
                                  </label>
                                  <select
                                    id={`shipping-condition-${index}`}
                                    className="b-select"
                                    value={tier.appliesWhen}
                                    onChange={(event) => updateShippingTier(index, "appliesWhen", event.target.value)}
                                  >
                                    <option value="">Any cart</option>
                                    <option value="one_time_only">One-time products only</option>
                                    <option value="has_subscription">Contains a subscription</option>
                                  </select>
                                </div>
                              </div>
                              {shippingTiers.length > 1 && (
                                <button
                                  type="button"
                                  className="b-btn b-btn-secondary b-btn-sm b-mt-3"
                                  onClick={() => setShippingTiers((current) => current.filter((_, tierIndex) => tierIndex !== index))}
                                >
                                  Remove tier
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="b-btn b-btn-secondary b-btn-sm b-mt-3"
                          onClick={() => setShippingTiers((current) => [
                            ...current,
                            {
                              ...DEFAULT_SHIPPING_TIER,
                              key: `shipping-tier-${Date.now()}-${current.length}`,
                              minimumSubtotal: "",
                            },
                          ])}
                        >
                          + Add shipping tier
                        </button>
                      </fieldset>
                    </>
                  )}

                  {/* Product gift / product discount targets */}
                  {(rewardType === "product_gift" || rewardType === "product_discount") && (
                    <>
                      <hr className="b-divider" />

                      {/* Product picker */}
                      <div>
                        <p className="b-label" style={{ marginBottom: 8 }}>
                          {rewardType === "product_discount" ? "Discounted Variants" : "Gift Products"}
                        </p>

                        {/* Selected GID tags */}
                        {selectedGiftGids.length > 0 && (
                          <div
                            className="b-row b-gap-2"
                            style={{ flexWrap: "wrap", marginBottom: 10 }}
                          >
                            {selectedGiftGids.map((gid) => (
                              <span
                                key={gid}
                                className="b-badge b-badge-gray b-row b-gap-2"
                                style={{ gap: 6 }}
                              >
                                {gid.split("/").pop()}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSelectedGiftGids((prev) =>
                                      prev.filter((g) => g !== gid)
                                    )
                                  }
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: 0,
                                    lineHeight: 1,
                                    color: "var(--text-sub)",
                                    fontSize: 12,
                                  }}
                                  title="Remove"
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        <button
                          type="button"
                          className="b-btn b-btn-secondary b-btn-sm"
                          onClick={() => setPickerOpen(true)}
                        >
                          {rewardType === "product_discount" ? "Select Discounted Variants" : "🎁 Select Gift Products"}
                        </button>
                        <input
                          type="hidden"
                          name="variantGids"
                          value={selectedGiftGids.join("\n")}
                        />
                      </div>

                      {/* Manual GID fallback */}
                      <div>
                        <label className="b-label" htmlFor="variantGidsManual">
                          Or paste GIDs manually (one per line)
                        </label>
                        <textarea
                          id="variantGidsManual"
                          name="variantGidsManual"
                          className="b-input"
                          rows={2}
                          autoComplete="off"
                          placeholder="gid://shopify/ProductVariant/12345"
                          style={{ resize: "vertical" }}
                        />
                        <p className="b-help">
                          Optional: paste GIDs directly if you know them.
                        </p>
                      </div>

                      {rewardType === "product_gift" && (
                        <div>
                          <label className="b-label" htmlFor="quantity">
                            Gift Quantity
                          </label>
                          <input
                            id="quantity"
                            name="quantity"
                            type="number"
                            className="b-input"
                            value={giftQuantity}
                            onChange={(e) => setGiftQuantity(e.target.value)}
                            min="1"
                            required
                            autoComplete="off"
                          />
                        </div>
                      )}

                      {rewardType === "product_gift" && <div>
                        <label className="b-label" htmlFor="trackMode">
                          Track Mode
                        </label>
                        <select
                          id="trackMode"
                          name="trackMode"
                          className="b-select"
                          defaultValue="product"
                        >
                          <option value="product">
                            Track by Product (any variant counts)
                          </option>
                          <option value="variant">
                            Track by Variant (exact variant only)
                          </option>
                        </select>
                      </div>}

                      {rewardType === "product_gift" && <label className="b-checkbox-row">
                        <input
                          type="checkbox"
                          name="isAutoAdd"
                        />
                        <div>
                          <span className="b-checkbox-label">
                            Auto-add gift to cart
                          </span>
                          <p className="b-checkbox-help">
                            Gift is automatically added when offer qualifies. Uncheck to show gift slider.
                          </p>
                        </div>
                      </label>}

                      {rewardType === "product_gift" && <label className="b-checkbox-row">
                        <input
                          type="checkbox"
                          name="isCustomerSelectable"
                        />
                        <div>
                          <span className="b-checkbox-label">
                            Customer selectable
                          </span>
                          <p className="b-checkbox-help">
                            Customer can choose this gift from the gift slider.
                          </p>
                        </div>
                      </label>}

                      {rewardType === "product_discount" && (
                        <div className="b-stack b-gap-4">
                          <div>
                            <label className="b-label" htmlFor="productScopeMode">Discount scope</label>
                            <select
                              id="productScopeMode"
                              name="productScopeMode"
                              className="b-select"
                              value={productScopeMode}
                              onChange={(event) => setProductScopeMode(event.target.value as typeof productScopeMode)}
                            >
                              <option value="sitewide">Sitewide / ordinary cart lines</option>
                              <option value="landing">Landing page lines (__landing_source)</option>
                              <option value="quiz_bundle">Product quiz bundle properties</option>
                            </select>
                          </div>

                          {productScopeMode !== "quiz_bundle" && (
                            <div className="b-grid-2">
                              <div>
                                <label className="b-label" htmlFor="lineQuantityEquals">Exact line quantity</label>
                                <input id="lineQuantityEquals" name="lineQuantityEquals" type="number" className="b-input" min="1" step="1" placeholder="Optional" autoComplete="off" />
                              </div>
                              <div>
                                <label className="b-label" htmlFor="maxUnitsTotal">Maximum discounted units</label>
                                <input id="maxUnitsTotal" name="maxUnitsTotal" type="number" className="b-input" min="1" step="1" placeholder="Optional" autoComplete="off" />
                              </div>
                              <div>
                                <label className="b-label" htmlFor="subscriptionMode">Purchase type</label>
                                <select id="subscriptionMode" name="subscriptionMode" className="b-select" defaultValue="any">
                                  <option value="any">Any purchase type</option>
                                  <option value="one_time_only">One-time purchase only</option>
                                  <option value="subscription_only">Subscription only</option>
                                </select>
                              </div>
                            </div>
                          )}

                          {productScopeMode === "landing" && (
                            <fieldset className="b-card b-p-4">
                              <legend className="b-label">Landing anti-abuse scope</legend>
                              <div className="b-stack b-gap-3">
                                <div>
                                  <label className="b-label" htmlFor="productLandingSource">Landing source value</label>
                                  <input id="productLandingSource" name="requiredLineAttributeValue" className="b-input" value={requiredLineAttributeValue} onChange={(event) => setRequiredLineAttributeValue(event.target.value)} required autoComplete="off" placeholder="protein-complete-lp" />
                                </div>
                                <div>
                                  <label className="b-label" htmlFor="productAnchorVariants">Anchor variant GIDs (one per line)</label>
                                  <textarea id="productAnchorVariants" name="requiredAnchorVariantIds" className="b-input" rows={3} value={requiredAnchorVariantIds} onChange={(event) => setRequiredAnchorVariantIds(event.target.value)} />
                                </div>
                                <div className="b-grid-2">
                                  <div>
                                    <label className="b-label" htmlFor="productAnchorMinQuantity">Minimum anchor quantity</label>
                                    <input id="productAnchorMinQuantity" name="requiredAnchorMinQuantity" type="number" className="b-input" min="1" step="1" value={requiredAnchorMinQuantity} onChange={(event) => setRequiredAnchorMinQuantity(event.target.value)} />
                                  </div>
                                  <label className="b-checkbox-row">
                                    <input type="checkbox" name="requiresAnchorSubscription" checked={requiresAnchorSubscription} onChange={(event) => setRequiresAnchorSubscription(event.target.checked)} />
                                    <span className="b-checkbox-label">Anchor must be a subscription</span>
                                  </label>
                                </div>
                              </div>
                            </fieldset>
                          )}

                          {productScopeMode === "landing" && discountType === "fixed_price" && (
                            <fieldset className="b-card b-p-4">
                              <legend className="b-label">Quantity price tiers</legend>
                              <input type="hidden" name="productPriceTiers" value={serializedProductPriceTiers} />
                              <div className="b-stack b-gap-3">
                                {productPriceTiers.map((tier, index) => (
                                  <div className="b-grid-2" key={tier.key}>
                                    <div>
                                      <label className="b-label" htmlFor={`product-tier-quantity-${index}`}>Quantity</label>
                                      <input id={`product-tier-quantity-${index}`} className="b-input" type="number" min="1" step="1" value={tier.quantity} onChange={(event) => setProductPriceTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: event.target.value } : item))} />
                                    </div>
                                    <div>
                                      <label className="b-label" htmlFor={`product-tier-price-${index}`}>Target price per unit</label>
                                      <input id={`product-tier-price-${index}`} className="b-input" type="number" min="0" step="0.01" value={tier.targetPricePerUnit} onChange={(event) => setProductPriceTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, targetPricePerUnit: event.target.value } : item))} />
                                    </div>
                                    {productPriceTiers.length > 1 && (
                                      <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setProductPriceTiers((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove tier</button>
                                    )}
                                  </div>
                                ))}
                                <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => setProductPriceTiers((current) => [...current, { key: `product-tier-${Date.now()}`, quantity: String(current.length + 1), targetPricePerUnit: "" }])}>+ Add price tier</button>
                              </div>
                            </fieldset>
                          )}

                          {productScopeMode === "quiz_bundle" && (
                            <div>
                              <label className="b-label" htmlFor="discountPercentageOnGifts">Quiz gift discount percentage</label>
                              <input id="discountPercentageOnGifts" name="discountPercentageOnGifts" type="number" className="b-input" min="0" max="100" step="0.01" defaultValue="100" />
                              <p className="b-help">Paid components reach _quiz_target_cents only when every expected paid line remains in the cart.</p>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Label */}
                  <div>
                    <label className="b-label" htmlFor="label">
                      Label{" "}
                      <span className="b-text-muted b-text-xs">(optional)</span>
                    </label>
                    <input
                      id="label"
                      name="label"
                      type="text"
                      className="b-input"
                      autoComplete="off"
                      placeholder="e.g. 'Choose your gift'"
                    />
                  </div>

                  {/* Form actions */}
                  <div className="b-row b-gap-3 b-mt-2">
                    <button
                      type="submit"
                      className="b-btn b-btn-primary"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? "Adding…" : "Add Reward"}
                    </button>
                    <button
                      type="button"
                      className="b-btn b-btn-secondary"
                      onClick={() => setAdding(false)}
                      disabled={isSubmitting}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Form>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
