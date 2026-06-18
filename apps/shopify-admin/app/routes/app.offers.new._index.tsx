import { useActionData, useNavigate, useLoaderData, Form, redirect } from "react-router";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { ensureOneOf, parseInteger, requiredText } from "../lib/offer-validation.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerCombinationPolicies, offerConditions, offerRewards } from "@promo/db";
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

function IllusGift() {
  return (
    <svg width="110" height="92" viewBox="0 0 110 92" fill="none">
      <rect x="14" y="44" width="82" height="44" rx="6" fill="rgba(255,255,255,0.22)"/>
      <rect x="8"  y="32" width="94" height="14" rx="5" fill="rgba(255,255,255,0.32)"/>
      <rect x="50" y="32" width="10" height="56" fill="rgba(255,255,255,0.42)"/>
      <rect x="14" y="60" width="82" height="9"  fill="rgba(255,255,255,0.18)"/>
      <ellipse cx="35" cy="22" rx="18" ry="11" fill="rgba(255,255,255,0.36)" transform="rotate(-18 35 22)"/>
      <ellipse cx="75" cy="22" rx="18" ry="11" fill="rgba(255,255,255,0.36)" transform="rotate(18 75 22)"/>
      <circle  cx="55" cy="29" r="8"  fill="rgba(255,255,255,0.58)"/>
      <circle  cx="16" cy="16" r="3.5" fill="rgba(255,255,255,0.32)"/>
      <circle  cx="94" cy="20" r="2.5" fill="rgba(255,255,255,0.28)"/>
      <circle  cx="100" cy="10" r="4" fill="rgba(255,255,255,0.18)"/>
    </svg>
  );
}

function IllusBundle() {
  return (
    <svg width="110" height="92" viewBox="0 0 110 92" fill="none">
      <rect x="36" y="50" width="58" height="38" rx="7" fill="rgba(255,255,255,0.17)"/>
      <rect x="22" y="38" width="58" height="38" rx="7" fill="rgba(255,255,255,0.25)"/>
      <rect x="8"  y="26" width="58" height="38" rx="7" fill="rgba(255,255,255,0.36)"/>
      <line x1="8"  y1="40" x2="66" y2="40" stroke="rgba(255,255,255,0.26)" strokeWidth="1.5"/>
      <line x1="37" y1="26" x2="37" y2="64" stroke="rgba(255,255,255,0.26)" strokeWidth="1.5"/>
      <rect x="16" y="47" width="22" height="4" rx="2" fill="rgba(255,255,255,0.28)"/>
      <rect x="16" y="53" width="14" height="4" rx="2" fill="rgba(255,255,255,0.20)"/>
      <rect x="64" y="9"  width="36" height="26" rx="6" fill="rgba(255,255,255,0.48)"/>
      <circle cx="74" cy="20" r="5" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2.2"/>
      <circle cx="90" cy="28" r="5" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2.2"/>
      <line   x1="88" y1="14" x2="76" y2="34" stroke="rgba(255,255,255,0.85)" strokeWidth="2.2" strokeLinecap="round"/>
    </svg>
  );
}

function IllusUpsell() {
  return (
    <svg width="110" height="92" viewBox="0 0 110 92" fill="none">
      <rect x="10" y="64" width="20" height="24" rx="4" fill="rgba(255,255,255,0.20)"/>
      <rect x="38" y="50" width="20" height="38" rx="4" fill="rgba(255,255,255,0.28)"/>
      <rect x="66" y="32" width="20" height="56" rx="4" fill="rgba(255,255,255,0.40)"/>
      <path d="M96 12 L104 23 M96 12 L87 23 M96 12 L96 56"
            stroke="rgba(255,255,255,0.82)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="20" cy="61" r="5.5" fill="rgba(255,255,255,0.40)"/>
      <circle cx="48" cy="47" r="5.5" fill="rgba(255,255,255,0.46)"/>
      <circle cx="76" cy="29" r="5.5" fill="rgba(255,255,255,0.55)"/>
    </svg>
  );
}

function IllusDiscount() {
  return (
    <svg width="110" height="92" viewBox="0 0 110 92" fill="none">
      <path d="M8 8 L60 8 Q80 8 88 28 Q80 48 60 48 L8 48 Q4 48 4 44 L4 12 Q4 8 8 8Z" fill="rgba(255,255,255,0.14)"/>
      <circle cx="20" cy="28" r="6"  fill="none" stroke="rgba(255,255,255,0.52)" strokeWidth="2"/>
      <circle cx="38" cy="26" r="14" fill="none" stroke="rgba(255,255,255,0.60)" strokeWidth="5"/>
      <circle cx="72" cy="62" r="14" fill="none" stroke="rgba(255,255,255,0.60)" strokeWidth="5"/>
      <line   x1="20" y1="80" x2="90" y2="14" stroke="rgba(255,255,255,0.70)" strokeWidth="5" strokeLinecap="round"/>
      <path   d="M94 8 L96 3 L98 8 L103 10 L98 12 L96 17 L94 12 L89 10Z" fill="rgba(255,255,255,0.45)"/>
      <circle cx="96" cy="72" r="3"  fill="rgba(255,255,255,0.30)"/>
      <circle cx="14" cy="76" r="4"  fill="rgba(255,255,255,0.25)"/>
    </svg>
  );
}

function IllusBooster() {
  return (
    <svg width="200" height="92" viewBox="0 0 200 92" fill="none">
      <rect x="20"  y="38" width="160" height="18" rx="9" fill="rgba(255,255,255,0.18)"/>
      <rect x="20"  y="38" width="112" height="18" rx="9" fill="rgba(255,255,255,0.44)"/>
      <circle cx="20"  cy="47" r="12" fill="rgba(255,255,255,0.28)"/>
      <circle cx="132" cy="47" r="14" fill="rgba(255,255,255,0.64)"/>
      <path d="M126 41 L124 38 L120 38 M126 41 L128 49 L140 49 L142 41 Z M130 52 a1.5 1.5 0 1 0 3 0 M137 52 a1.5 1.5 0 1 0 3 0"
            stroke="rgba(180,83,9,0.75)" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
      <circle cx="65"  cy="47" r="4.5" fill="rgba(255,255,255,0.52)"/>
      <circle cx="110" cy="47" r="4.5" fill="rgba(255,255,255,0.52)"/>
      <rect x="38"  y="20" width="44" height="12" rx="3" fill="rgba(255,255,255,0.24)"/>
      <rect x="90"  y="20" width="44" height="12" rx="3" fill="rgba(255,255,255,0.24)"/>
      <circle cx="28"  cy="22" r="4"  fill="rgba(255,255,255,0.32)"/>
      <circle cx="162" cy="20" r="3"  fill="rgba(255,255,255,0.28)"/>
      <circle cx="176" cy="28" r="5"  fill="rgba(255,255,255,0.20)"/>
      <rect x="150" y="60" width="46" height="22" rx="5" fill="rgba(255,255,255,0.32)"/>
      <rect x="155" y="66" width="18" height="4" rx="2" fill="rgba(255,255,255,0.52)"/>
      <rect x="155" y="72" width="12" height="3" rx="2" fill="rgba(255,255,255,0.38)"/>
    </svg>
  );
}

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
    color: "#d97706",
    gradient: "linear-gradient(135deg, #fbbf24 0%, #d97706 100%)",
    illus: <IllusGift />,
    wide: false,
  },
  {
    value: "bundle",
    label: "Bundle Offer",
    desc: "Group products with a discount — classic bundles, mix & match, or build-your-own.",
    color: "#0d9488",
    gradient: "linear-gradient(135deg, #2dd4bf 0%, #0d9488 100%)",
    illus: <IllusBundle />,
    wide: false,
  },
  {
    value: "upsell",
    label: "Upsell Offer",
    desc: "Recommend products at checkout or on the product page (Frequently Bought Together).",
    color: "#7c3aed",
    gradient: "linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)",
    illus: <IllusUpsell />,
    wide: false,
  },
  {
    value: "discount",
    label: "Discount Offer",
    desc: "Volume tiers, cart discounts, or cheapest/most expensive item promotions.",
    color: "#e11d48",
    gradient: "linear-gradient(135deg, #fb7185 0%, #e11d48 100%)",
    illus: <IllusDiscount />,
    wide: false,
  },
  {
    value: "booster",
    label: "Booster",
    desc: "Today Offer widget or progress bar — surfaces active offers across the entire storefront.",
    color: "#b45309",
    gradient: "linear-gradient(135deg, #fbbf24 0%, #b45309 100%)",
    illus: <IllusBooster />,
    wide: true,
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
          <div style={{ padding: 16 }}>
            <div className="ot-grid">
              {OFFER_TYPES.map((type) => {
                const active = offerType === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setOfferType(type.value)}
                    className={`ot-card${type.wide ? " ot-wide" : ""}${active ? ` ot-active-${type.value}` : ""}`}
                  >
                    <div className="ot-card-illus" style={{ background: type.gradient }}>
                      <div className="ot-illus-img">{type.illus}</div>
                      {active && (
                        <div className="ot-card-check">
                          <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                            <path d="M4 10l4 4 8-8" stroke={type.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="ot-card-body">
                      <div className="ot-card-name">{type.label}</div>
                      <p className="ot-card-desc">{type.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
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
