import { useActionData, useNavigate, useLoaderData, Form, redirect } from "react-router";
import { Suspense, lazy, useState } from "react";
import { Toast } from "../components/Toast.js";
import { PageHeader } from "../components/PageHeader.js";
import type { OfferCreateModalType } from "../components/offers/OfferCreateModalFlow.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isConstraintViolation, isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { ensureOneOf, parseInteger, requiredText } from "../lib/offer-validation.server.js";
import { createFieldSetter, useObjectState } from "../hooks/useObjectState.js";
import { offers, offerCombinationPolicies, offerConditions, offerRewards, discountCodes } from "@promo/db";
import { CODE_TAKEN_MESSAGE, DISCOUNT_CODE_INDEX, normalizeTypedCode } from "../lib/discount-codes.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

const OfferCreateModalFlow = lazy(() => import("../components/offers/OfferCreateModalFlow.js"));

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

// Steps of the shared create-offer catalogue (components/offers/OfferCreateModalFlow) reachable via ?type=.
const CATALOGUE_STEPS: ReadonlySet<string> = new Set(["gift", "bundle", "upsell", "discount", "shipping", "subscription", "codes"]);

const VALID_TYPES = ["gift", "bundle", "upsell", "discount", "booster"] as const;

// Extra selectable card that isn't a real DB offer type — it stores as
// "discount" underneath (see `dbOfferTypeFor`) plus a first discount code.
const SELECTABLE_TYPES = [...VALID_TYPES, "checkout_code_promo"] as const;

function dbOfferTypeFor(selectedType: string): (typeof VALID_TYPES)[number] {
  return selectedType === "checkout_code_promo" ? "discount" : (selectedType as (typeof VALID_TYPES)[number]);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type");
  // Code promos have their own wizard (codes, discount, pages, UTM in one place).
  if (typeParam === "checkout_code_promo") throw redirect("/app/offers/new/codes/single");
  const initialType = CATALOGUE_STEPS.has(typeParam ?? "") || typeParam === "booster" ? typeParam! : "type";
  return { shopDomain: session.shop, initialType };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  const { shopId, db } = context;
  if (!shopId) return { error: "Shop not found" };

  const offerTypeResult = ensureOneOf(formData.get("offerType") as string | null, SELECTABLE_TYPES, "gift", "Offer type");
  if (offerTypeResult.error) return { error: offerTypeResult.error };
  const selectedType = offerTypeResult.data!;
  const offerType = dbOfferTypeFor(selectedType);
  const template = (formData.get("template") as string) ?? "scratch";
  const preset = TEMPLATE_PRESETS[template];

  // The first code is created with the offer; more are added on the Codes tab.
  let initialCode: string | null = null;
  if (selectedType === "checkout_code_promo") {
    const codeResult = normalizeTypedCode(formData.get("requiredDiscountCode"));
    if (!codeResult.ok) return { error: codeResult.error };
    initialCode = codeResult.code;
  }

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
        .values({
          shopId,
          type: offerType,
          status: "draft",
          internalName: candidateName,
          publicTitle,
          priority,
          requiresCode: initialCode !== null,
        })
        .returning({ id: offers.id });
      if (!offer) throw new Error("Failed to create offer");
      if (initialCode) {
        await tx.insert(discountCodes).values({ shopId, offerId: offer.id, code: initialCode });
      }

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
    // The internal-name and discount-code uniqueness checks share the same
    // Postgres error code (23505) — only retry-with-a-different-name when
    // the name index is really what failed. A discount-code collision needs
    // a friendly error instead: retrying with a suffixed name would resubmit
    // the SAME already-taken code and fail again, uncaught.
    if (isConstraintViolation(err, DISCOUNT_CODE_INDEX)) return { error: CODE_TAKEN_MESSAGE };
    if (!isUniqueViolation(err)) throw err;
    newOffer = await createOfferWithChildren(withUniqueOfferSuffix(internalName));
  }

  if (!newOffer) return { error: "Failed to create offer" };

  return redirect(`/app/offers/${newOffer.id}`);
};

export default function NewOfferPage() {
  const { initialType } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [step, setStep] = useState<OfferCreateModalType>(
    initialType === "type" || CATALOGUE_STEPS.has(initialType) ? (initialType as OfferCreateModalType) : "type",
  );
  if (initialType === "booster") return <BoosterDetailsForm />;
  return (
    <div className="b-page">
      <PageHeader title="Create new offer" backTo="/app/offers" />
      <Suspense fallback={null}>
        <OfferCreateModalFlow modal={step} onClose={() => void navigate("/app/offers")} onChange={setStep} />
      </Suspense>
    </div>
  );
}

function BoosterDetailsForm() {
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const [formState, setFormField] = useObjectState(() => ({
    internalName: "",
    publicTitle: "",
    priority: "100",
    fieldErrors: {} as { internalName?: string; publicTitle?: string; priority?: string },
    showToast: false,
    toastMsg: "",
  }));
  const { internalName, publicTitle, priority, fieldErrors, showToast, toastMsg } = formState;
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
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>Create booster</h1>
        <p style={{ fontSize: 14, color: "var(--text-sub)", margin: 0 }}>
          Name your booster. You can change its settings later.
        </p>
      </div>

      <Form method="POST" onSubmit={(e: React.FormEvent<HTMLFormElement>) => { if (!validate()) e.preventDefault(); }}>
        <input type="hidden" name="offerType" value="booster" />

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
                aria-invalid={fieldErrors.internalName ? true : undefined}
                aria-describedby={fieldErrors.internalName ? "internalName-error" : undefined}
                name="internalName"
                value={internalName}
                onChange={(e) => { setInternalName(e.target.value); setFieldErrors((p) => ({ ...p, internalName: undefined })); }}
                placeholder="e.g., free-gift-50-usd-cart"
                autoComplete="off"
              />
              {fieldErrors.internalName
                ? <div id="internalName-error" className="b-help-error" role="alert">{fieldErrors.internalName}</div>
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
                aria-invalid={fieldErrors.publicTitle ? true : undefined}
                aria-describedby={fieldErrors.publicTitle ? "publicTitle-error" : undefined}
                name="publicTitle"
                value={publicTitle}
                onChange={(e) => { setPublicTitle(e.target.value); setFieldErrors((p) => ({ ...p, publicTitle: undefined })); }}
                placeholder="e.g., Free Gift with $50 Purchase"
                autoComplete="off"
              />
              {fieldErrors.publicTitle
                ? <div id="publicTitle-error" className="b-help-error" role="alert">{fieldErrors.publicTitle}</div>
                : <div className="b-help">Displayed to customers in widgets and cart messages.</div>
              }
            </div>
            <div style={{ maxWidth: 140 }}>
              <label className="b-label" htmlFor="priority">Priority</label>
              <input
                id="priority"
                className={`b-input${fieldErrors.priority ? " b-input-error" : ""}`}
                aria-invalid={fieldErrors.priority ? true : undefined}
                aria-describedby={fieldErrors.priority ? "priority-error" : undefined}
                name="priority"
                type="number"
                min="1"
                value={priority}
                onChange={(e) => { setPriority(e.target.value); setFieldErrors((p) => ({ ...p, priority: undefined })); }}
                autoComplete="off"
              />
              {fieldErrors.priority
                ? <div id="priority-error" className="b-help-error" role="alert">{fieldErrors.priority}</div>
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
