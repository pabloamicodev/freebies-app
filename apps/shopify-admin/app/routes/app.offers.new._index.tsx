import { useActionData, useNavigate, useLoaderData, Form, redirect } from "react-router";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { ensureOneOf, parseInteger, requiredText } from "../lib/offer-validation.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerCombinationPolicies, offerConditions, offerRewards } from "@promo/db";
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

const VALID_TYPES = ["gift", "bundle", "upsell", "discount", "booster"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type") ?? "gift";
  const initialType = (VALID_TYPES as readonly string[]).includes(typeParam) ? typeParam : "gift";
  return { shopDomain: session.shop, initialType };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, db } = context;
  if (!shopId) return { error: "Shop not found" };

  const offerTypeResult = ensureOneOf(formData.get("offerType") as string | null, VALID_TYPES, "gift", "Offer type");
  if (offerTypeResult.error) return { error: offerTypeResult.error };
  const offerType = offerTypeResult.data!;
  const template = (formData.get("template") as string) ?? "scratch";
  const preset = TEMPLATE_PRESETS[template];

  // Names: form values take priority; preset provides fallback defaults
  const formName = (formData.get("internalName") as string)?.trim();
  const formTitle = (formData.get("publicTitle") as string)?.trim();
  const internalName = formName || preset?.internalName || "";
  const publicTitle = formTitle || preset?.publicTitle || "";
  const priorityResult = parseInteger(formData, "priority", 100, { min: 1, label: "Priority" });
  if (priorityResult.error) return { error: priorityResult.error };
  const priority = priorityResult.data!;

  if (!internalName) return { error: requiredText(formData, "internalName", "Internal name").error ?? "Internal name is required." };
  if (!publicTitle) return { error: requiredText(formData, "publicTitle", "Public title").error ?? "Public title is required." };

  // Offer + policy (+ preset condition/reward) created atomically. Unique-name
  // retry wraps the whole tx (a failed insert aborts the Postgres transaction).
  async function createOfferWithChildren(candidateName: string) {
    return db.transaction(async (tx) => {
      const [offer] = await tx
        .insert(offers)
        .values({ shopId, type: offerType as "gift" | "bundle" | "upsell" | "discount" | "booster", status: "draft", internalName: candidateName, publicTitle, priority })
        .returning({ id: offers.id });
      if (!offer) throw new Error("Failed to create offer");

      const setupTasks: Array<PromiseLike<unknown>> = [
        tx.insert(offerCombinationPolicies).values({
          shopId,
          offerId: offer.id,
          combinesWithOrderDiscounts: true,
          combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: true,
          combinesWithOtherAppOffers: true,
          stopLowerPriority: false,
          giftValueCountsForOtherOffers: false,
        }),
      ];

      // Pre-create condition + reward from template preset
      if (preset) {
        setupTasks.push(
          tx.insert(offerConditions).values({
            shopId,
            offerId: offer.id,
            scope: preset.condition.scope,
            conditionType: preset.condition.conditionType,
            operator: preset.condition.operator as "gte" | "lte" | "eq" | "in",
            value: preset.condition.value,
            sortOrder: 0,
            isEnabled: true,
          }),
          tx.insert(offerRewards).values({
            shopId,
            offerId: offer.id,
            rewardType: preset.reward.rewardType as "product_gift" | "order_discount" | "bundle_discount" | "upsell_discount",
            discountType: preset.reward.discountType as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
            value: { amount: 100, currencyCode: "USD" },
            target: { scope: "cart" },
            quantity: preset.reward.quantity,
            isAutoAdd: preset.reward.isAutoAdd,
            isCustomerSelectable: true,
            trackMode: "product",
            sortOrder: 0,
          }),
        );
      }
      await Promise.all(setupTasks);

      return offer;
    });
  }

  let newOffer: { id: string } | undefined;
  try {
    newOffer = await createOfferWithChildren(internalName);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    newOffer = await createOfferWithChildren(withUniqueOfferSuffix(internalName));
  }

  if (!newOffer) return { error: "Failed to create offer" };

  return redirect(`/app/offers/${newOffer.id}`);
};

const OFFER_TYPES = [
  {
    value: "gift",
    label: "Gift Offer",
    desc: "Auto-add or let customers select a free product when the cart hits a threshold.",
    color: "#f97316",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.75 4.5a.75.75 0 0 0-1.5 0v.75h-1.5A2.25 2.25 0 0 0 5.5 7.5v.75H3.75A.75.75 0 0 0 3 9v7.25A1.75 1.75 0 0 0 4.75 18h10.5A1.75 1.75 0 0 0 17 16.25V9a.75.75 0 0 0-.75-.75H14.5V7.5a2.25 2.25 0 0 0-2.25-2.25h-1.5V4.5ZM9.25 7.5h-1.5a.75.75 0 0 0 0 1.5H9.25v3.5H4.5V9.75h1.25V8.25H4.5V7.5a.75.75 0 0 1 .75-.75h4V7.5Zm1.5 0v-.75h1.5a.75.75 0 0 1 .75.75v.75h-1.25v1.5H14V9.75h-3.25V9h1.25V8.25H10.75V7.5Zm-1.5 5V9.75h1.5V12.5h-1.5Zm-4.75 0H9.25v4H4.75a.25.25 0 0 1-.25-.25V12.5Zm5.75 4V12.5h4.75v3.75a.25.25 0 0 1-.25.25H10.75Z"/>
      </svg>
    ),
  },
  {
    value: "bundle",
    label: "Bundle Offer",
    desc: "Group products with a discount — classic bundles, mix & match, or build-your-own.",
    color: "#3b82f6",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M2 3.75A.75.75 0 0 1 2.75 3h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75ZM2 7.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.5ZM2.75 10.75a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5ZM14.25 9.5a.75.75 0 0 1 .75.75v4.69l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l1.72 1.72V10.25a.75.75 0 0 1 .75-.75Z" clipRule="evenodd"/>
      </svg>
    ),
  },
  {
    value: "upsell",
    label: "Upsell Offer",
    desc: "Recommend products at checkout or on the product page (Frequently Bought Together).",
    color: "#8b5cf6",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z" clipRule="evenodd"/>
      </svg>
    ),
  },
  {
    value: "discount",
    label: "Discount Offer",
    desc: "Volume tiers, cart discounts, or cheapest/most expensive item promotions.",
    color: "#10b981",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM6.75 9.25a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z" clipRule="evenodd"/>
      </svg>
    ),
  },
  {
    value: "booster",
    label: "Booster",
    desc: "Today Offer widget or progress bar — surfaces active offers across the entire storefront.",
    color: "#f59e0b",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
        <path fillRule="evenodd" d="M10.38 1.103a.75.75 0 0 0-1.042.155L5.45 6.38H2.75a.75.75 0 0 0-.75.75v5.74a.75.75 0 0 0 .75.75H5.45l3.888 5.122a.75.75 0 0 0 1.31-.407l.001-.01.004-.04.012-.119a31.516 31.516 0 0 0 .115-2.047c.035-1.354.026-3.34-.395-5.293.421-1.952.43-3.94.395-5.293a31.55 31.55 0 0 0-.115-2.047l-.012-.119-.004-.04-.001-.01a.75.75 0 0 0-.268-.414Z" clipRule="evenodd"/>
      </svg>
    ),
  },
];

export default function NewOfferPage() {
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const { initialType } = useLoaderData<typeof loader>();
  const [formState, setFormField] = useObjectState(() => ({
    offerType: initialType ?? "gift",
    internalName: "",
    publicTitle: "",
    priority: "100",
    fieldErrors: {} as { internalName?: string; publicTitle?: string; priority?: string },
    showToast: false,
    toastMsg: "",
  }));
  const { offerType, internalName, publicTitle, priority, fieldErrors, showToast, toastMsg } = formState;
  const setOfferType = createFieldSetter(setFormField, "offerType");
  const setInternalName = createFieldSetter(setFormField, "internalName");
  const setPublicTitle = createFieldSetter(setFormField, "publicTitle");
  const setPriority = createFieldSetter(setFormField, "priority");
  const setFieldErrors = createFieldSetter(setFormField, "fieldErrors");
  const setShowToast = createFieldSetter(setFormField, "showToast");
  const setToastMsg = createFieldSetter(setFormField, "toastMsg");

  function validate() {
    const errs: { internalName?: string; publicTitle?: string; priority?: string } = {};
    if (!internalName.trim()) errs.internalName = "Internal name is required";
    if (!publicTitle.trim()) errs.publicTitle = "Public title is required";
    if (isNaN(parseInt(priority, 10))) errs.priority = "Priority must be a number";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setToastMsg(Object.values(errs)[0]!);
      setShowToast(true);
      return false;
    }
    return true;
  }

  return (
    <div className="b-page" style={{ maxWidth: 680, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <button
          type="button"
          className="rd-style-011"
          onClick={() => navigate("/app/offers")}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd"/></svg>
          All Offers
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>Create new offer</h1>
        <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
          Choose a type to get started. You can always change settings later.
        </p>
      </div>

      <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
        <input type="hidden" name="offerType" value={offerType} />

        {/* ── Offer type selector ── */}
        <div className="b-card" style={{ marginBottom: 16 }}>
          <div className="b-card-header">
            <span>Offer type</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-sub)" }}>Select one</span>
          </div>
          <div className="b-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: 16 }}>
            {OFFER_TYPES.map((type) => {
              const active = offerType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setOfferType(type.value)}
                  className="rd-style-012" style={{ border: `2px solid ${active ? "var(--blue)" : "var(--border)"}`, background: active ? "var(--blue-light, #f0f4ff)" : "var(--bg-card)", boxShadow: active ? "0 0 0 3px rgba(44,110,203,0.12)" : "none" }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                    <div className="rd-style-013" style={{ background: active ? type.color : `${type.color}1a`, color: active ? "#fff" : type.color }}>
                      {type.icon}
                    </div>
                    {active && (
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--blue)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <svg width="10" height="10" viewBox="0 0 20 20" fill="white"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd"/></svg>
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{type.label}</div>
                    <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.4 }}>{type.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Offer details ── */}
        <div className="b-card" style={{ marginBottom: 20 }}>
          <div className="b-card-header" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="var(--text-sub)"><path fillRule="evenodd" d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.621a1.5 1.5 0 0 0-.44-1.06l-4.12-4.122A1.5 1.5 0 0 0 11.378 2H4.5Zm2.25 8.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0 3a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0-6a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd"/></svg>
            <span>Offer details</span>
          </div>
          <div className="b-card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <label className="b-label" htmlFor="internalName">
                Internal name <span style={{ color: "var(--red, #e53e3e)" }}>*</span>
              </label>
              <input
                id="internalName"
                className={`b-input${fieldErrors.internalName ? " b-input-error" : ""}`}
                name="internalName"
                value={internalName}
                onChange={(e) => { setInternalName(e.target.value); setFieldErrors((p) => ({ ...p, internalName: undefined })); }}
                placeholder="e.g., free-gift-50-usd-cart"
                autoComplete="off"
              />
              {fieldErrors.internalName
                ? <div className="b-help-error">{fieldErrors.internalName}</div>
                : <div className="b-help">Only visible to your team. Used to identify this offer.</div>
              }
            </div>
            <div>
              <label className="b-label" htmlFor="publicTitle">
                Public title <span style={{ color: "var(--red, #e53e3e)" }}>*</span>
              </label>
              <input
                id="publicTitle"
                className={`b-input${fieldErrors.publicTitle ? " b-input-error" : ""}`}
                name="publicTitle"
                value={publicTitle}
                onChange={(e) => { setPublicTitle(e.target.value); setFieldErrors((p) => ({ ...p, publicTitle: undefined })); }}
                placeholder="e.g., Free Gift with $50 Purchase"
                autoComplete="off"
              />
              {fieldErrors.publicTitle
                ? <div className="b-help-error">{fieldErrors.publicTitle}</div>
                : <div className="b-help">Displayed to customers in widgets and cart messages.</div>
              }
            </div>
            <div style={{ maxWidth: 140 }}>
              <label className="b-label" htmlFor="priority">Priority</label>
              <input
                id="priority"
                className={`b-input${fieldErrors.priority ? " b-input-error" : ""}`}
                name="priority"
                type="number"
                min="1"
                value={priority}
                onChange={(e) => { setPriority(e.target.value); setFieldErrors((p) => ({ ...p, priority: undefined })); }}
                autoComplete="off"
              />
              {fieldErrors.priority
                ? <div className="b-help-error">{fieldErrors.priority}</div>
                : <div className="b-help">Lower = evaluated first.</div>
              }
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button type="button" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-sub)", fontSize: 13, padding: 0 }} onClick={() => navigate("/app/offers")}>
            Cancel
          </button>
          <button type="submit" className="b-btn b-btn-primary" style={{ padding: "10px 22px", fontSize: 14 }}>
            Create offer and continue
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd"/></svg>
          </button>
        </div>
      </Form>

      {(showToast || actionData?.error) && (
        <Toast message={actionData?.error ?? toastMsg} type="error" onDismiss={() => setShowToast(false)} />
      )}
    </div>
  );
}
