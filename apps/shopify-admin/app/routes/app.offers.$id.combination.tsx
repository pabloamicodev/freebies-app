/**
 * Combination Policy editor — Step 6 of the offer builder wizard.
 * Controls stacking, combination with other discounts, max applications.
 */

import { useLoaderData, Form, Link } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, policyRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
  ]);

  return { offer: offerRows[0], policy: policyRows[0] ?? null };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id!;

  const policy = {
    shopId,
    offerId,
    combinesWithOrderDiscounts: formData.get("order_discounts") === "on",
    combinesWithProductDiscounts: formData.get("product_discounts") === "on",
    combinesWithShippingDiscounts: formData.get("shipping_discounts") === "on",
    combinesWithOtherAppOffers: formData.get("other_app_offers") === "on",
    stopLowerPriority: formData.get("stop_lower_priority") === "on",
    giftValueCountsForOtherOffers: formData.get("gift_value_counts") === "on",
    maxApplicationsPerCart: formData.get("max_per_cart") ? parseInt(formData.get("max_per_cart") as string, 10) : null,
    maxApplicationsPerCustomer: formData.get("max_per_customer") ? parseInt(formData.get("max_per_customer") as string, 10) : null,
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

  return null;
};

export default function OfferCombinationPage() {
  const { offer, policy } = useLoaderData<typeof loader>();
  if (!offer) return <div className="b-page"><p>Not found.</p></div>;

  return (
    <div className="b-page">
      {/* Header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <Link
            to={`/app/offers/${offer.id}`}
            className="b-btn b-btn-secondary b-btn-sm"
            style={{ textDecoration: "none" }}
          >
            &#8592;
          </Link>
          <div>
            <h1 className="b-page-title">Combination Policy</h1>
            <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>{offer.internalName}</p>
          </div>
        </div>
      </div>

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

                  {/* max applications */}
                  <div>
                    <label className="b-label" htmlFor="max_applications">Max applications per cart</label>
                    <input
                      id="max_applications"
                      className="b-input"
                      type="number"
                      name="max_applications"
                      min={1}
                      defaultValue={policy?.maxApplicationsPerCart?.toString() ?? ""}
                      placeholder="Unlimited"
                      style={{ maxWidth: 200 }}
                    />
                    <p className="b-help">Limit how many times this offer can apply in a single cart (e.g., 1 for one-time only). Leave blank for unlimited.</p>
                  </div>

                  {/* Save */}
                  <div className="b-editor-footer">
                    <button type="submit" className="b-btn b-btn-primary">
                      Save Combination Policy
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
