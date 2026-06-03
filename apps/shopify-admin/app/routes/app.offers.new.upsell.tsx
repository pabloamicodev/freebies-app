/**
 * Upsell Offer Builder — FBT, checkout upsell, and thank-you page upsell.
 */

import { Form, useNavigate, redirect } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import "../styles/bogos.css";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const upsellType = formData.get("upsellType") as string; // "fbt", "checkout", "thank_you"
  const internalName = formData.get("internalName") as string;
  const publicTitle = formData.get("publicTitle") as string;
  const maxProducts = parseInt(formData.get("maxProducts") as string, 10) || 3;
  const discountType = formData.get("discountType") as string;
  const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
  const currencyCode = (formData.get("currencyCode") as string) || "USD";
  const upsellVariantGids = (formData.get("upsellVariantGids") as string)
    .split("\n").map((v) => v.trim()).filter(Boolean);
  const buttonText = (formData.get("buttonText") as string) || "Add to Cart";
  const checkoutTarget = (formData.get("checkoutTarget") as string) || "purchase.checkout.block.render";

  const [newOffer] = await db.insert(offers).values({
    shopId, type: "upsell", status: "draft",
    internalName, publicTitle, priority: 100,
  }).returning({ id: offers.id });

  if (!newOffer) return { error: "Failed to create offer" };

  await db.insert(offerCombinationPolicies).values({
    shopId, offerId: newOffer.id,
    combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
    stopLowerPriority: false, giftValueCountsForOtherOffers: false,
  });

  // Store upsell config as a condition for type/placement info
  await db.insert(offerConditions).values({
    shopId, offerId: newOffer.id,
    scope: "visibility",
    conditionType: "sales_channels",
    operator: "in",
    value: {
      channels: upsellType === "checkout" ? ["online_store"] : ["online_store"],
      upsellType,
      checkoutTarget,
      maxProducts,
      buttonText,
      layout: upsellType === "fbt" ? (formData.get("fbtLayout") as string ?? "amazon") : undefined,
    },
    sortOrder: 0, isEnabled: true,
  });

  // Create reward
  await db.insert(offerRewards).values({
    shopId, offerId: newOffer.id,
    rewardType: "upsell_discount",
    discountType: discountType as any,
    value: { amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100), currencyCode },
    target: { variantIds: upsellVariantGids },
    quantity: null,
    isAutoAdd: false, isCustomerSelectable: true,
    sortOrder: 0, label: buttonText,
  });

  return redirect(`/app/offers/${newOffer.id}`);
};

export default function NewUpsellPage() {
  const navigate = useNavigate();
  const [upsellType, setUpsellType] = useState<"fbt" | "checkout" | "thank_you">("fbt");
  const [discountType, setDiscountType] = useState("percentage");

  const CHECKOUT_TARGETS = [
    { label: "Order Summary (after order total)", value: "purchase.checkout.block.render" },
    { label: "Above Pay Now button", value: "purchase.checkout.actions.render-before" },
    { label: "After cart line items", value: "purchase.checkout.cart-line-item.render-after" },
    { label: "Thank-you / Post-purchase page", value: "purchase.thank-you.block.render" },
  ];

  return (
    <div className="b-page">
      {/* Page header */}
      <div className="b-page-header">
        <div className="b-page-title-row">
          <button
            type="button"
            className="b-btn b-btn-secondary b-btn-sm"
            onClick={() => navigate("/app/offers")}
          >
            &larr; All Offers
          </button>
          <h1 className="b-page-title">New Upsell Offer</h1>
        </div>
      </div>

      <Form method="POST">
        <div className="b-stack b-stack-4">

          {/* Upsell Type */}
          <div className="b-card">
            <div className="b-card-header">Upsell Type</div>
            <div className="b-card-body b-stack b-stack-3">
              <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="_upsellTypeRadio"
                  checked={upsellType === "fbt"}
                  onChange={() => setUpsellType("fbt")}
                />
                <div>
                  <div className="b-checkbox-label">
                    Frequently Bought Together &mdash; product page widget
                  </div>
                  <div className="b-checkbox-help">
                    Amazon-style &lsquo;frequently bought together&rsquo; widget on product pages.
                  </div>
                </div>
              </label>

              <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="_upsellTypeRadio"
                  checked={upsellType === "checkout"}
                  onChange={() => setUpsellType("checkout")}
                />
                <div>
                  <div className="b-checkbox-label">
                    Checkout Upsell &mdash; inject widget at checkout
                    <span className="b-shopify-plus-badge">Plus</span>
                  </div>
                  <div className="b-checkbox-help">
                    Shopify Plus only. Show upsell at any checkout step.
                  </div>
                </div>
              </label>

              <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="_upsellTypeRadio"
                  checked={upsellType === "thank_you"}
                  onChange={() => setUpsellType("thank_you")}
                />
                <div>
                  <div className="b-checkbox-label">
                    Thank-You Page Upsell &mdash; post-purchase
                    <span className="b-shopify-plus-badge">Plus</span>
                  </div>
                  <div className="b-checkbox-help">
                    Shopify Plus only. Show upsell after order is placed.
                  </div>
                </div>
              </label>

              <input type="hidden" name="upsellType" value={upsellType} />
            </div>
          </div>

          {/* Upsell Details */}
          <div className="b-card">
            <div className="b-card-header">Upsell Details</div>
            <div className="b-card-body b-stack b-stack-3">
              <div>
                <label className="b-label" htmlFor="internalName">Internal Name</label>
                <input
                  id="internalName"
                  className="b-input"
                  type="text"
                  name="internalName"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="b-label" htmlFor="publicTitle">Public Title</label>
                <input
                  id="publicTitle"
                  className="b-input"
                  type="text"
                  name="publicTitle"
                  autoComplete="off"
                  placeholder="You might also like..."
                />
              </div>
              <div>
                <label className="b-label" htmlFor="buttonText">Button Text</label>
                <input
                  id="buttonText"
                  className="b-input"
                  type="text"
                  name="buttonText"
                  autoComplete="off"
                  defaultValue="Add to Cart"
                />
              </div>
              <div>
                <label className="b-label" htmlFor="maxProducts">Max Products to Show</label>
                <input
                  id="maxProducts"
                  className="b-input"
                  type="number"
                  name="maxProducts"
                  autoComplete="off"
                  defaultValue="3"
                  style={{ maxWidth: 120 }}
                />
              </div>
            </div>
          </div>

          {/* FBT Layout (conditional) */}
          {upsellType === "fbt" && (
            <div className="b-card">
              <div className="b-card-header">FBT Layout</div>
              <div className="b-card-body">
                <label className="b-label" htmlFor="fbtLayout">Layout style</label>
                <select id="fbtLayout" className="b-select" name="fbtLayout">
                  <option value="amazon">Amazon-style (horizontal)</option>
                  <option value="stacked">Stacked (vertical)</option>
                </select>
              </div>
            </div>
          )}

          {/* Checkout Placement (conditional) */}
          {(upsellType === "checkout" || upsellType === "thank_you") && (
            <div className="b-card">
              <div className="b-card-header">
                Checkout Placement
                <span className="b-shopify-plus-badge" style={{ marginLeft: 8 }}>Plus</span>
              </div>
              <div className="b-card-body">
                <label className="b-label" htmlFor="checkoutTarget">Target surface</label>
                <select id="checkoutTarget" className="b-select" name="checkoutTarget">
                  {CHECKOUT_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Upsell Products */}
          <div className="b-card">
            <div className="b-card-header">Upsell Products</div>
            <div className="b-card-body">
              <label className="b-label" htmlFor="upsellVariantGids">
                Product Variant GIDs (one per line)
              </label>
              <textarea
                id="upsellVariantGids"
                className="b-input"
                name="upsellVariantGids"
                rows={4}
                autoComplete="off"
                placeholder={"gid://shopify/ProductVariant/12345\ngid://shopify/ProductVariant/67890"}
                style={{ resize: "vertical" }}
              />
              <p className="b-help">Products to recommend. For FBT and checkout upsell.</p>
            </div>
          </div>

          {/* Discount */}
          <div className="b-card">
            <div className="b-card-header">Discount</div>
            <div className="b-card-body b-stack b-stack-3">
              <div>
                <label className="b-label" htmlFor="discountType">Discount type</label>
                <select
                  id="discountType"
                  className="b-select"
                  name="discountType"
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value)}
                >
                  <option value="fixed_price">No discount</option>
                  <option value="percentage">Percentage off</option>
                  <option value="fixed_amount">Fixed amount off</option>
                </select>
              </div>

              {discountType !== "fixed_price" && (
                <div className="b-grid-2">
                  <div>
                    <label className="b-label" htmlFor="discountValue">
                      {discountType === "percentage" ? "%" : "$"} Discount value
                    </label>
                    <input
                      id="discountValue"
                      className="b-input"
                      type="number"
                      name="discountValue"
                      autoComplete="off"
                      min="0"
                      step="0.01"
                    />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="currencyCode">Currency</label>
                    <input
                      id="currencyCode"
                      className="b-input"
                      type="text"
                      name="currencyCode"
                      autoComplete="off"
                      defaultValue="USD"
                    />
                  </div>
                </div>
              )}

              {discountType === "fixed_price" && (
                <input type="hidden" name="discountValue" value="0" />
              )}
            </div>
          </div>

          {/* Form actions */}
          <div className="b-editor-footer">
            <button
              type="button"
              className="b-btn b-btn-secondary"
              onClick={() => navigate("/app/offers")}
            >
              Cancel
            </button>
            <button type="submit" className="b-btn b-btn-primary">
              Create Upsell Offer
            </button>
          </div>

        </div>
      </Form>
    </div>
  );
}
