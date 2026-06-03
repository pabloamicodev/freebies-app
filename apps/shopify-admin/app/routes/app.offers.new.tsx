import { useState } from "react";
import { useNavigate, Form, redirect } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerCombinationPolicies, offerConditions, offerRewards, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

// Pre-configured condition + reward for each gift template
const TEMPLATE_PRESETS: Record<string, {
  internalName: string;
  publicTitle: string;
  condition: { conditionType: string; scope: "main" | "sub"; value: object; operator: string };
  reward: { rewardType: string; discountType: string; quantity: number; isAutoAdd: boolean };
}> = {
  cart_value: {
    internalName: "Spend X amount to get gift",
    publicTitle: "Spend X amount to get gift(s)",
    condition: {
      conditionType: "cart_value",
      scope: "main",
      operator: "gte",
      value: { thresholdCents: 50000, currencyCode: "USD", appliesTo: "any_product", includeGiftValues: false },
    },
    reward: { rewardType: "product_gift", discountType: "free", quantity: 1, isAutoAdd: true },
  },
  buy_x_gift: {
    internalName: "Free sample with purchase",
    publicTitle: "Free sample with purchase",
    condition: {
      conditionType: "cart_quantity",
      scope: "main",
      operator: "gte",
      value: { minQuantity: 1, appliesTo: "any_product", includeGiftValues: false },
    },
    reward: { rewardType: "product_gift", discountType: "free", quantity: 1, isAutoAdd: true },
  },
  bogo: {
    internalName: "BOGO Buy 1 get 1 the same",
    publicTitle: "BOGO (Buy 1 get 1 the same)",
    condition: {
      conditionType: "specific_product",
      scope: "main",
      operator: "gte",
      value: { minQtyPerProduct: 1, multiplyGifts: true, giftsMatchProducts: true, trackMode: "variant", appliesTo: "specific_products", variantIds: [] },
    },
    reward: { rewardType: "product_gift", discountType: "free", quantity: 1, isAutoAdd: true },
  },
  buy_x_get_y: {
    internalName: "BXGY Buy X get Y",
    publicTitle: "BXGY (Buy X get Y)",
    condition: {
      conditionType: "specific_product",
      scope: "main",
      operator: "gte",
      value: { minQtyPerProduct: 1, multiplyGifts: false, giftsMatchProducts: false, trackMode: "product", appliesTo: "specific_products", variantIds: [] },
    },
    reward: { rewardType: "product_gift", discountType: "free", quantity: 1, isAutoAdd: true },
  },
  tiered: {
    internalName: "Spend more get more",
    publicTitle: "Spend more get more",
    condition: {
      conditionType: "cart_value_multiplier",
      scope: "main",
      operator: "gte",
      value: { thresholdCents: 50000, currencyCode: "USD", appliesTo: "any_product", includeGiftValues: false },
    },
    reward: { rewardType: "product_gift", discountType: "free", quantity: 1, isAutoAdd: true },
  },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();

  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const offerType = formData.get("offerType") as string;
  const template = (formData.get("template") as string) ?? "scratch";
  const preset = TEMPLATE_PRESETS[template];

  // Names: use preset if available, otherwise form values
  const formName = formData.get("internalName") as string;
  const formTitle = formData.get("publicTitle") as string;
  const internalName = preset ? preset.internalName : formName;
  const publicTitle = preset ? preset.publicTitle : formTitle;
  const priority = parseInt(formData.get("priority") as string, 10) || 100;

  if (!internalName || !publicTitle || !offerType) {
    return { error: "Internal name, public title, and type are required" };
  }

  const [newOffer] = await db
    .insert(offers)
    .values({ shopId, type: offerType as any, status: "draft", internalName, publicTitle, priority })
    .returning({ id: offers.id });

  if (!newOffer) return { error: "Failed to create offer" };

  await db.insert(offerCombinationPolicies).values({
    shopId,
    offerId: newOffer.id,
    combinesWithOrderDiscounts: true,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  });

  // Pre-create condition + reward from template preset
  if (preset) {
    await db.insert(offerConditions).values({
      shopId,
      offerId: newOffer.id,
      scope: preset.condition.scope,
      conditionType: preset.condition.conditionType,
      operator: preset.condition.operator as any,
      value: preset.condition.value,
      sortOrder: 0,
      isEnabled: true,
    });

    await db.insert(offerRewards).values({
      shopId,
      offerId: newOffer.id,
      rewardType: preset.reward.rewardType as any,
      discountType: preset.reward.discountType as any,
      value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart" },
      quantity: preset.reward.quantity,
      isAutoAdd: preset.reward.isAutoAdd,
      isCustomerSelectable: true,
      trackMode: "product",
      sortOrder: 0,
    });
  }

  return redirect(`/app/offers/${newOffer.id}`);
};

const OFFER_TYPES = [
  {
    value: "gift",
    emoji: "🎁",
    label: "Gift Offer",
    desc: "Auto-add or let customer select a free product when cart meets a threshold.",
    color: "#ff6b35",
  },
  {
    value: "bundle",
    emoji: "📦",
    label: "Bundle Offer",
    desc: "Group products together with a discount — classic bundle, mix & match, or build-a-box.",
    color: "#3b82f6",
  },
  {
    value: "upsell",
    emoji: "⬆️",
    label: "Upsell Offer",
    desc: "Show a recommended product at checkout or on the product page (FBT).",
    color: "#8b5cf6",
  },
  {
    value: "discount",
    emoji: "💰",
    label: "Discount Offer",
    desc: "Volume tiers, cart-level discount, or cheapest / most expensive item free.",
    color: "#10b981",
  },
  {
    value: "booster",
    emoji: "🚀",
    label: "Booster",
    desc: "Today Offer widget or progress bar — shows active offers site-wide.",
    color: "#f59e0b",
  },
];

function IconChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6"/>
    </svg>
  );
}

export default function NewOfferPage() {
  const navigate = useNavigate();
  const [offerType, setOfferType] = useState("gift");
  const [internalName, setInternalName] = useState("");
  const [publicTitle, setPublicTitle] = useState("");
  const [priority, setPriority] = useState("100");
  const [error, setError] = useState("");

  function validate() {
    if (!internalName.trim()) { setError("Internal name is required"); return false; }
    if (!publicTitle.trim()) { setError("Public title is required"); return false; }
    if (isNaN(parseInt(priority, 10))) { setError("Priority must be a number"); return false; }
    setError("");
    return true;
  }

  return (
    <div className="b-page">
      {/* Back + Header */}
      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="b-btn-plain b-text-sm"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 12 }}
          onClick={() => navigate("/app/offers")}
        >
          <IconChevronLeft /> All Offers
        </button>
        <h1 className="b-page-title">Create new offer</h1>
      </div>

      {error && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <div className="b-banner-title">Validation error</div>
            <p className="b-banner-text">{error}</p>
          </div>
        </div>
      )}

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        <input type="hidden" name="offerType" value={offerType} />

        {/* Offer type selector */}
        <div className="b-card b-mb-4">
          <div className="b-card-header">Offer type</div>
          <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {OFFER_TYPES.map((type) => (
              <label
                key={type.value}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: `2px solid ${offerType === type.value ? "var(--blue)" : "var(--border)"}`,
                  cursor: "pointer",
                  background: offerType === type.value ? "var(--blue-light)" : "transparent",
                  transition: "border-color 0.15s, background 0.15s",
                }}
                onClick={() => setOfferType(type.value)}
              >
                <input
                  type="radio"
                  name="offerTypeRadio"
                  value={type.value}
                  checked={offerType === type.value}
                  onChange={() => setOfferType(type.value)}
                  style={{ accentColor: "var(--blue)", width: 16, height: 16 }}
                />
                <div
                  style={{
                    width: 36, height: 36,
                    borderRadius: 8,
                    background: type.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 18,
                    flexShrink: 0,
                  }}
                >
                  {type.emoji}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{type.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>{type.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Offer details */}
        <div className="b-card b-mb-4">
          <div className="b-card-header">Offer details</div>
          <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label className="b-label" htmlFor="internalName">Internal name</label>
              <input
                id="internalName"
                className="b-input"
                name="internalName"
                value={internalName}
                onChange={(e) => setInternalName(e.target.value)}
                placeholder="e.g., free-gift-50-usd-cart"
                autoComplete="off"
              />
              <div className="b-help">Used internally to identify this offer. Must be unique.</div>
            </div>
            <div>
              <label className="b-label" htmlFor="publicTitle">Public title</label>
              <input
                id="publicTitle"
                className="b-input"
                name="publicTitle"
                value={publicTitle}
                onChange={(e) => setPublicTitle(e.target.value)}
                placeholder="e.g., Free Gift with $50 Purchase"
                autoComplete="off"
              />
              <div className="b-help">Shown to customers in widgets and cart messages.</div>
            </div>
            <div>
              <label className="b-label" htmlFor="priority">Priority</label>
              <input
                id="priority"
                className="b-input"
                name="priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                autoComplete="off"
                style={{ maxWidth: 120 }}
              />
              <div className="b-help">Lower number = higher priority. Evaluated first when multiple offers are active.</div>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="b-btn b-btn-secondary" onClick={() => navigate("/app/offers")}>
            Cancel
          </button>
          <button type="submit" className="b-btn b-btn-primary">
            Create & continue to conditions →
          </button>
        </div>
      </Form>
    </div>
  );
}
