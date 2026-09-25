import { useEffect, useMemo, useState } from "react";
import { Form, redirect, useActionData, useNavigate, useNavigation, useParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  ShippingDiscountRewardPayloadSchema,
  type ShippingDiscountTier,
} from "@promo/shared-types";
import { offerCombinationPolicies, offerConditions, offerRewards, offers } from "@promo/db";
import { Toast } from "../components/Toast.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "../lib/unique-offer-name.server.js";
import { parseDateRange, requiredText } from "../lib/offer-validation.server.js";
import { statusForSubmit } from "../lib/offer-scheduling.server.js";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard.js";
import { finalizeCreatedOffer } from "../lib/offer-publish-flow.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const TEMPLATE_SCOPE = {
  global: "sitewide",
  landing: "landing",
  quiz: "quiz_bundle",
} as const;

type ShippingTemplate = keyof typeof TEMPLATE_SCOPE;
type TierDraft = {
  id: string;
  minimum: string;
  maximum: string;
  discountType: "percentage" | "fixed_amount";
  discountValue: string;
  appliesWhen: "" | "has_subscription" | "one_time_only";
};

function tierDraft(seed: Partial<TierDraft> = {}): TierDraft {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `shipping-tier-${Date.now()}-${Math.random()}`,
    minimum: "0",
    maximum: "",
    discountType: "percentage",
    discountValue: "100",
    appliesWhen: "",
    ...seed,
  };
}

function parseTierPayload(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string") return { error: "Configure at least one shipping tier." } as const;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return { error: "Shipping tiers must be an array." } as const;
    const tiers: ShippingDiscountTier[] = value.map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new Error("Every shipping tier must be an object.");
      const tier = entry as Record<string, unknown>;
      return {
        minimumSubtotalCents: Math.round(Number(tier.minimumSubtotalCents)),
        ...(tier.maximumSubtotalCents === undefined
          ? {}
          : { maximumSubtotalCents: Math.round(Number(tier.maximumSubtotalCents)) }),
        discountType: tier.discountType === "fixed_amount" ? "fixed_amount" : "percentage",
        discountValue: Number(tier.discountValue),
        ...(tier.appliesWhen === "has_subscription" || tier.appliesWhen === "one_time_only"
          ? { appliesWhen: tier.appliesWhen }
          : {}),
      };
    });
    return { tiers } as const;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid shipping tier configuration.",
    } as const;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const [context, formData] = await Promise.all([getShopContext(request), request.formData()]);
  if (!context.shopId) return { error: "Shop not found." };
  const { db, shopId, session } = context;
  const internalNameResult = requiredText(formData, "internalName", "Internal name");
  if (internalNameResult.error) return { error: internalNameResult.error };
  const publicTitleResult = requiredText(formData, "publicTitle", "Public title");
  if (publicTitleResult.error) return { error: publicTitleResult.error };
  const dateRange = parseDateRange(formData);
  if (dateRange.error) return { error: dateRange.error };

  const template = (formData.get("template") as ShippingTemplate) || "global";
  const scopeMode = TEMPLATE_SCOPE[template] ?? "sitewide";
  const tiersResult = parseTierPayload(formData.get("shippingTiers"));
  if ("error" in tiersResult) return { error: tiersResult.error };
  const deliveryGroupTypes = [
    ...(formData.get("oneTimeDelivery") === "on" ? ["ONE_TIME_PURCHASE" as const] : []),
    ...(formData.get("subscriptionDelivery") === "on" ? ["SUBSCRIPTION" as const] : []),
  ];
  const requiredLineAttributeValue = String(formData.get("landingSource") ?? "").trim();
  const requiredAnchorVariantIds = String(formData.get("anchorVariantIds") ?? "")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const requiredAnchorMinQuantity = Math.max(
    1,
    Number.parseInt(String(formData.get("anchorMinimum") ?? "1"), 10) || 1,
  );
  const target = {
    deliveryGroupTypes,
    scopeMode,
    ...(scopeMode === "landing"
      ? {
          requiredLineAttributeKey: "__landing_source" as const,
          requiredLineAttributeValue,
          requiredAnchorVariantIds,
          requiredAnchorMinQuantity,
          requiresAnchorSubscription: formData.get("anchorSubscription") === "on",
        }
      : {}),
  };
  const payloadResult = ShippingDiscountRewardPayloadSchema.safeParse({
    discountType: tiersResult.tiers[0]?.discountType ?? "percentage",
    value: {
      amount: tiersResult.tiers[0]?.discountValue ?? 0,
      currencyCode: "USD",
      tiers: tiersResult.tiers,
    },
    target,
  });
  if (!payloadResult.success) {
    return { error: payloadResult.error.issues[0]?.message ?? "Invalid shipping configuration." };
  }
  const validatedPayload = payloadResult.data;

  const internalName = internalNameResult.data!;
  const publicTitle = publicTitleResult.data!;
  const description = String(formData.get("description") ?? "").trim() || null;
  const status = statusForSubmit(
    String(formData.get("intent") ?? "draft"),
    dateRange.data!.startsAt,
  );
  const minimumThreshold = Math.min(...tiersResult.tiers.map((tier) => tier.minimumSubtotalCents));

  async function createOffer(candidateName: string) {
    return db.transaction(async (tx) => {
      const [offer] = await tx
        .insert(offers)
        .values({
          shopId,
          type: "discount",
          status,
          internalName: candidateName,
          publicTitle,
          description,
          priority: 100,
          startsAt: dateRange.data!.startsAt ?? new Date(),
          endsAt: dateRange.data!.endsAt,
        })
        .returning({ id: offers.id });
      if (!offer) throw new Error("Failed to create shipping offer.");
      await Promise.all([
        tx.insert(offerConditions).values({
          shopId,
          offerId: offer.id,
          scope: "main",
          conditionType: "cart_value",
          operator: "gte",
          value: {
            thresholdCents: minimumThreshold,
            currencyCode: "USD",
            includeGiftValues: false,
          },
          sortOrder: 0,
          isEnabled: true,
        }),
        tx.insert(offerRewards).values({
          shopId,
          offerId: offer.id,
          rewardType: "shipping_discount",
          discountType: validatedPayload.discountType,
          value: validatedPayload.value,
          target: validatedPayload.target,
          isAutoAdd: false,
          isCustomerSelectable: false,
          trackMode: "product",
          sortOrder: 0,
        }),
        tx.insert(offerCombinationPolicies).values({
          shopId,
          offerId: offer.id,
          combinesWithOrderDiscounts: true,
          combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: false,
          combinesWithOtherAppOffers: true,
          stopLowerPriority: false,
          giftValueCountsForOtherOffers: false,
        }),
      ]);
      return offer;
    });
  }

  let offer: { id: string } | undefined;
  try {
    offer = await createOffer(internalName);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    offer = await createOffer(withUniqueOfferSuffix(internalName));
  }
  const publishError = await finalizeCreatedOffer(db, shopId, session.shop, offer.id, status);
  if (publishError) return { error: publishError };
  return redirect(`/app/offers/${offer.id}`);
};

export default function NewShippingOfferPage() {
  const { template: rawTemplate = "global" } = useParams();
  const template = (rawTemplate in TEMPLATE_SCOPE ? rawTemplate : "global") as ShippingTemplate;
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const { markDirty, blocker } = useUnsavedGuard(isSubmitting);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [tiers, setTiers] = useState<TierDraft[]>([
    tierDraft({ minimum: "100", discountValue: "100" }),
  ]);
  const [oneTimeDelivery, setOneTimeDelivery] = useState(true);
  const [subscriptionDelivery, setSubscriptionDelivery] = useState(true);
  useEffect(() => {
    if (actionData?.error) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [actionData?.error]);
  useEffect(() => {
    if (navigation.state === "submitting") setDismissedError(null);
  }, [navigation.state]);
  const serializedTiers = useMemo(
    () =>
      JSON.stringify(
        tiers.map((tier) => ({
          minimumSubtotalCents: Math.round((Number(tier.minimum) || 0) * 100),
          ...(tier.maximum ? { maximumSubtotalCents: Math.round(Number(tier.maximum) * 100) } : {}),
          discountType: tier.discountType,
          discountValue: Number(tier.discountValue) || 0,
          ...(tier.appliesWhen ? { appliesWhen: tier.appliesWhen } : {}),
        })),
      ),
    [tiers],
  );
  const title =
    template === "global"
      ? "Global shipping offer"
      : template === "landing"
        ? "Landing-page shipping offer"
        : "Quiz bundle shipping offer";

  return (
    <div className="b-page">
      <div style={{ marginBottom: 28 }}>
        <button
          type="button"
          className="b-btn-plain b-text-sm"
          onClick={() => void navigate("/app/offers")}
          style={{ marginBottom: 14 }}
        >
          ← All Offers
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              color: "#fff",
              background: "linear-gradient(135deg,#38bdf8,#0369a1)",
            }}
          >
            🚚
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
            <div className="b-help">Tiered delivery discounts compiled to Shopify Functions</div>
          </div>
        </div>
      </div>
      <Form method="post" onChange={markDirty}>
        <input type="hidden" name="template" value={template} />
        <input type="hidden" name="shippingTiers" value={serializedTiers} />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="b-card" style={{ borderTop: "3px solid #0ea5e9" }}>
            <div className="b-card-header">Offer information</div>
            <div className="b-card-body" style={{ display: "grid", gap: 14 }}>
              <div className="b-grid-2">
                <div>
                  <label className="b-label" htmlFor="shipping-name">
                    Internal name
                  </label>
                  <input
                    id="shipping-name"
                    className="b-input"
                    name="internalName"
                    required
                    defaultValue={title}
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="shipping-title">
                    Public title
                  </label>
                  <input
                    id="shipping-title"
                    className="b-input"
                    name="publicTitle"
                    required
                    defaultValue={template === "global" ? "Shipping savings" : title}
                  />
                </div>
              </div>
              <div>
                <label className="b-label" htmlFor="shipping-description">
                  Description
                </label>
                <textarea
                  id="shipping-description"
                  className="b-input"
                  name="description"
                  rows={2}
                />
              </div>
              <div className="b-grid-2">
                <div>
                  <label className="b-label" htmlFor="shipping-start">
                    Starts at
                  </label>
                  <input
                    id="shipping-start"
                    className="b-input"
                    type="datetime-local"
                    name="startsAt"
                    defaultValue={new Date().toISOString().slice(0, 16)}
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="shipping-end">
                    Ends at
                  </label>
                  <input
                    id="shipping-end"
                    className="b-input"
                    type="datetime-local"
                    name="endsAt"
                  />
                </div>
              </div>
            </div>
          </div>

          {template === "landing" && (
            <div className="b-card">
              <div className="b-card-header">Trusted landing source</div>
              <div className="b-card-body" style={{ display: "grid", gap: 14 }}>
                <div>
                  <label className="b-label" htmlFor="landing-source">
                    Landing source code
                  </label>
                  <input
                    id="landing-source"
                    className="b-input"
                    name="landingSource"
                    required
                    placeholder="ambrosia-landing"
                  />
                  <div className="b-help">
                    The storefront must copy this value into the line property{" "}
                    <code>__landing_source</code>. The Function verifies it at checkout.
                  </div>
                </div>
                <div>
                  <label className="b-label" htmlFor="anchor-variants">
                    Anchor variant GIDs (optional)
                  </label>
                  <textarea
                    id="anchor-variants"
                    className="b-input"
                    name="anchorVariantIds"
                    rows={3}
                    placeholder="gid://shopify/ProductVariant/…"
                  />
                </div>
                <div className="b-grid-2">
                  <div>
                    <label className="b-label" htmlFor="anchor-minimum">
                      Minimum anchor quantity
                    </label>
                    <input
                      id="anchor-minimum"
                      className="b-input"
                      name="anchorMinimum"
                      type="number"
                      min="1"
                      defaultValue="1"
                    />
                  </div>
                  <label className="b-checkbox-row">
                    <input type="checkbox" name="anchorSubscription" />
                    <span>Anchor line must be a subscription</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="b-card">
            <div className="b-card-header">Shipping tiers</div>
            <div className="b-card-body" style={{ display: "grid", gap: 12 }}>
              {tiers.map((tier, index) => (
                <div className="b-card" key={tier.id} style={{ background: "var(--bg-hover)" }}>
                  <div
                    className="b-card-header"
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span>Tier {index + 1}</span>
                    {tiers.length > 1 && (
                      <button
                        type="button"
                        className="b-modal-close"
                        aria-label={`Remove tier ${index + 1}`}
                        onClick={() =>
                          setTiers((current) => current.filter((item) => item.id !== tier.id))
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="b-card-body b-shipping-tier-grid">
                    <div>
                      <label className="b-label">Minimum subtotal</label>
                      <input
                        aria-label={`Tier ${index + 1} minimum subtotal`}
                        className="b-input"
                        type="number"
                        min="0"
                        step="0.01"
                        value={tier.minimum}
                        onChange={(event) =>
                          setTiers((current) =>
                            current.map((item) =>
                              item.id === tier.id ? { ...item, minimum: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <div>
                      <label className="b-label">Maximum subtotal</label>
                      <input
                        aria-label={`Tier ${index + 1} maximum subtotal`}
                        className="b-input"
                        type="number"
                        min={tier.minimum || "0"}
                        step="0.01"
                        placeholder="No max"
                        value={tier.maximum}
                        onChange={(event) =>
                          setTiers((current) =>
                            current.map((item) =>
                              item.id === tier.id ? { ...item, maximum: event.target.value } : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <div>
                      <label className="b-label">Discount type</label>
                      <select
                        className="b-select"
                        value={tier.discountType}
                        onChange={(event) =>
                          setTiers((current) =>
                            current.map((item) =>
                              item.id === tier.id
                                ? {
                                    ...item,
                                    discountType: event.target.value as TierDraft["discountType"],
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="percentage">Percentage</option>
                        <option value="fixed_amount">Fixed amount</option>
                      </select>
                    </div>
                    <div>
                      <label className="b-label">Value</label>
                      <input
                        aria-label={`Tier ${index + 1} discount value`}
                        className="b-input"
                        type="number"
                        min="0"
                        max={tier.discountType === "percentage" ? "100" : undefined}
                        step="0.01"
                        value={tier.discountValue}
                        onChange={(event) =>
                          setTiers((current) =>
                            current.map((item) =>
                              item.id === tier.id
                                ? { ...item, discountValue: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>
                    <div>
                      <label className="b-label">Applies when</label>
                      <select
                        className="b-select"
                        value={tier.appliesWhen}
                        onChange={(event) =>
                          setTiers((current) =>
                            current.map((item) =>
                              item.id === tier.id
                                ? {
                                    ...item,
                                    appliesWhen: event.target.value as TierDraft["appliesWhen"],
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="">Any cart</option>
                        <option value="has_subscription">Has subscription</option>
                        <option value="one_time_only">One-time only</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="b-btn b-btn-secondary"
                onClick={() => setTiers((current) => [...current, tierDraft({ minimum: "" })])}
              >
                + Add shipping tier
              </button>
            </div>
          </div>

          <div className="b-card">
            <div className="b-card-header">Delivery groups</div>
            <div className="b-card-body" style={{ display: "flex", gap: 20 }}>
              <label className="b-checkbox-row">
                <input
                  type="checkbox"
                  name="oneTimeDelivery"
                  checked={oneTimeDelivery}
                  onChange={(event) => setOneTimeDelivery(event.target.checked)}
                />
                <span>One-time purchase</span>
              </label>
              <label className="b-checkbox-row">
                <input
                  type="checkbox"
                  name="subscriptionDelivery"
                  checked={subscriptionDelivery}
                  onChange={(event) => setSubscriptionDelivery(event.target.checked)}
                />
                <span>Subscription</span>
              </label>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button
              type="button"
              className="b-btn b-btn-secondary"
              onClick={() => void navigate("/app/offers")}
            >
              Cancel
            </button>
            <button
              type="submit"
              name="intent"
              value="draft"
              className="b-btn b-btn-secondary"
              disabled={isSubmitting}
            >
              Save draft
            </button>
            <button
              type="submit"
              name="intent"
              value="publish"
              className="b-btn b-btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Create and publish"}
            </button>
          </div>
        </div>
      </Form>
      {blocker.state === "blocked" && (
        <div className="b-modal-overlay">
          <div className="b-modal">
            <div className="b-modal-body">
              <h2>Discard unsaved changes?</h2>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="b-btn b-btn-secondary" onClick={() => blocker.reset()}>
                  Keep editing
                </button>
                <button className="b-btn b-btn-primary" onClick={() => blocker.proceed()}>
                  Discard
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {actionData?.error && actionData.error !== dismissedError && (
        <Toast
          type="error"
          message={actionData.error}
          onDismiss={() => setDismissedError(actionData.error ?? null)}
        />
      )}
    </div>
  );
}
