/**
 * Combination Policy editor — Step 6 of the offer builder wizard.
 * Controls stacking, combination with other discounts, max applications.
 */

import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { NotFound } from "../components/NotFound.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { republishIfActive } from "../lib/offer-publish-flow.server.js";
import { offerCombinationPolicies } from "@promo/db";
import { and, eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const [policyRows] = await Promise.all([
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
  ]);

  return { offer, policy: policyRows[0] ?? null };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const policy = {
    shopId,
    offerId,
    combinesWithOrderDiscounts: formData.get("order_discounts") === "on",
    combinesWithProductDiscounts: formData.get("product_discounts") === "on",
    combinesWithShippingDiscounts: formData.get("shipping_discounts") === "on",
    combinesWithOtherAppOffers: formData.get("other_app_offers") === "on",
    stopLowerPriority: formData.get("stop_lower_priority") === "on",
    giftValueCountsForOtherOffers: formData.get("gift_value_counts") === "on",
    maxApplicationsPerCart: (() => { const v = parseInt(formData.get("max_per_cart") as string, 10); return Number.isFinite(v) && v > 0 ? v : null; })(),
    maxApplicationsPerCustomer: (() => { const v = parseInt(formData.get("max_per_customer") as string, 10); return Number.isFinite(v) && v > 0 ? v : null; })(),

  };

  await db.insert(offerCombinationPolicies)
    .values(policy)
    .onConflictDoUpdate({
      target: [offerCombinationPolicies.offerId],
      set: {
        combinesWithOrderDiscounts: policy.combinesWithOrderDiscounts,
        combinesWithProductDiscounts: policy.combinesWithProductDiscounts,
        combinesWithShippingDiscounts: policy.combinesWithShippingDiscounts,
        combinesWithOtherAppOffers: policy.combinesWithOtherAppOffers,
        stopLowerPriority: policy.stopLowerPriority,
        giftValueCountsForOtherOffers: policy.giftValueCountsForOtherOffers,
        maxApplicationsPerCart: policy.maxApplicationsPerCart,
        maxApplicationsPerCustomer: policy.maxApplicationsPerCustomer,
        updatedAt: new Date(),
      },
    });

  const publishError = await republishIfActive(db, shopId, session.shop, offerId, offer.status === "active");
  if (publishError) return { error: publishError };

  return { success: true };
};

export default function OfferCombinationPage() {
  const { offer, policy } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  if (!offer) return <NotFound message="Not found." />;

  return (
    <div className="b-page">
      {/* Header */}
      <PageHeader title="Combination Policy" subtitle={offer.internalName} backTo={`/app/offers/${offer.id}`} />

      {/* Two-column editor layout */}
      <div className="b-editor-layout">
        {/* Main form card */}
        <div className="b-editor-main">
          <div className="b-editor-section">
            <h2 className="b-editor-section-title">Combination with other discounts</h2>
            <div className="b-editor-section-body">
              <Form method="POST">
                <div className="b-stack b-stack-4">

                  {/* order discounts */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="order_discounts"
                      defaultChecked={policy?.combinesWithOrderDiscounts ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Combines with order discounts</div>
                      <div className="b-checkbox-help">Allow this offer to stack with other order-level discounts (e.g., coupon codes).</div>
                    </div>
                  </label>

                  {/* product discounts */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="product_discounts"
                      defaultChecked={policy?.combinesWithProductDiscounts ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Combines with product discounts</div>
                      <div className="b-checkbox-help">Allow this offer to stack with product-level discounts.</div>
                    </div>
                  </label>

                  {/* shipping discounts */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="shipping_discounts"
                      defaultChecked={policy?.combinesWithShippingDiscounts ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Combines with shipping discounts</div>
                      <div className="b-checkbox-help">Allow this offer to stack with free shipping or shipping discount codes.</div>
                    </div>
                  </label>

                  {/* other app offers */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="other_app_offers"
                      defaultChecked={policy?.combinesWithOtherAppOffers ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Combines with other app offers</div>
                      <div className="b-checkbox-help">Allow this offer to apply alongside other active promo engine offers.</div>
                    </div>
                  </label>

                  <hr className="b-divider" />

                  <p className="b-text-sm b-text-bold" style={{ margin: 0 }}>Priority behavior</p>

                  {/* stop lower priority */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="stop_lower_priority"
                      defaultChecked={policy?.stopLowerPriority ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Stop lower priority offers</div>
                      <div className="b-checkbox-help">When this offer qualifies, offers with higher priority numbers will not be evaluated. Useful for exclusive promotions.</div>
                    </div>
                  </label>

                  {/* gift value counts */}
                  <label className="b-checkbox-row">
                    <input
                      type="checkbox"
                      name="gift_value_counts"
                      defaultChecked={policy?.giftValueCountsForOtherOffers ?? false}
                    />
                    <div>
                      <div className="b-checkbox-label">Gift value counts for other offers</div>
                      <div className="b-checkbox-help">By default, gift line values don&apos;t count toward the cart value of other offers. Enable this to include them.</div>
                    </div>
                  </label>

                  <hr className="b-divider" />

                  {/* max applications per cart */}
                  <div>
                    <label className="b-label" htmlFor="max_per_cart">Max applications per cart</label>
                    <input
                      id="max_per_cart"
                      className="b-input"
                      type="number"
                      name="max_per_cart"
                      min={1}
                      defaultValue={policy?.maxApplicationsPerCart?.toString() ?? ""}
                      placeholder="Unlimited"
                      style={{ maxWidth: 200 }}
                    />
                    <p className="b-help">Limit how many times this offer can apply in a single cart. Leave blank for unlimited.</p>
                  </div>

                  {/* max applications per customer */}
                  <div>
                    <label className="b-label" htmlFor="max_per_customer">Max applications per customer</label>
                    <input
                      id="max_per_customer"
                      className="b-input"
                      type="number"
                      name="max_per_customer"
                      min={1}
                      defaultValue={policy?.maxApplicationsPerCustomer?.toString() ?? ""}
                      placeholder="Unlimited"
                      style={{ maxWidth: 200 }}
                    />
                    <p className="b-help">Limit how many times a single customer can benefit from this offer. Leave blank for unlimited.</p>
                  </div>

                  {/* Feedback */}
                  {actionData && "success" in actionData && (
                    <div className="b-banner b-banner-green">
                      <span className="b-banner-icon">✓</span>
                      <p className="b-banner-text" style={{ margin: 0 }}>Combination policy saved.</p>
                    </div>
                  )}

                  {/* Save */}
                  <div className="b-editor-footer">
                    <button type="submit" className="b-btn b-btn-primary" disabled={isSubmitting}>
                      {isSubmitting ? "Saving…" : "Save Combination Policy"}
                    </button>
                  </div>

                </div>
              </Form>
            </div>
          </div>
        </div>

        {/* Sidebar info card */}
        <div className="b-editor-sidebar">
          <div className="b-card">
            <div className="b-card-header">About combination policies</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  Combination policies control whether this offer can be active at the same time as other discounts and offers in the cart.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  <strong className="b-text-bold" style={{ color: "var(--text)" }}>Order discounts</strong> include coupon codes and automatic order-level discounts applied by Shopify.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  <strong className="b-text-bold" style={{ color: "var(--text)" }}>Product discounts</strong> apply to individual line items, such as percentage or fixed-amount discounts on specific products.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  <strong className="b-text-bold" style={{ color: "var(--text)" }}>Stop lower priority</strong> lets you make an offer exclusive — once it triggers, lower-priority offers are skipped entirely.
                </p>
                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  <strong className="b-text-bold" style={{ color: "var(--text)" }}>Max applications</strong> caps how many times the same offer fires in one cart, preventing stacking beyond what you intend.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
