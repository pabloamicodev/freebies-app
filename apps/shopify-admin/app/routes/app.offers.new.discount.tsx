/**
 * Discount offer builder — volume discount, cart discount, cheapest item free.
 * Creates offers with discount_type conditions and rewards.
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

  const discountSubtype = formData.get("discountSubtype") as string; // "volume", "cart", "cheapest_item"
  const internalName = formData.get("internalName") as string;
  const publicTitle = formData.get("publicTitle") as string;
  const discountType = formData.get("discountType") as string; // "percentage" | "fixed_amount" | "free"
  const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
  const thresholdCents = Math.round(parseFloat(formData.get("threshold") as string || "0") * 100);
  const currencyCode = (formData.get("currencyCode") as string) || "USD";

  const [newOffer] = await db.insert(offers).values({
    shopId,
    type: "discount",
    status: "draft",
    internalName,
    publicTitle,
    priority: 100,
  }).returning({ id: offers.id });

  if (!newOffer) return { error: "Failed to create offer" };

  // Create condition based on subtype
  if (discountSubtype === "cart" || discountSubtype === "volume") {
    await db.insert(offerConditions).values({
      shopId,
      offerId: newOffer.id,
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents, currencyCode, includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    });
  }

  // Volume discount tiers (if provided)
  const tiers = formData.getAll("tier_qty[]").map((q, i) => ({
    minQuantity: parseInt(q as string, 10),
    label: formData.getAll("tier_label[]")[i] as string,
    discountType: formData.getAll("tier_discount_type[]")[i] as string,
    discountValue: parseFloat(formData.getAll("tier_discount_value[]")[i] as string),
  }));

  // Reward
  const rewardTarget: Record<string, unknown> = {};
  if (discountSubtype === "cheapest_item" || discountSubtype === "cart") {
    rewardTarget["scope"] = "all";
  }

  await db.insert(offerRewards).values({
    shopId,
    offerId: newOffer.id,
    rewardType: "order_discount",
    discountType: discountType as any,
    value: {
      amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100),
      currencyCode,
      tiers: tiers.length > 0 ? tiers : undefined,
    },
    target: rewardTarget,
    quantity: null,
    isAutoAdd: false,
    isCustomerSelectable: false,
    sortOrder: 0,
    label: null,
  });

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

  return redirect(`/app/offers/${newOffer.id}`);
};

export default function NewDiscountOfferPage() {
  const navigate = useNavigate();
  const [discountSubtype, setDiscountSubtype] = useState<"volume" | "cart" | "cheapest_item">("cart");
  const [discountType, setDiscountType] = useState("percentage");
  const [tiers, setTiers] = useState([{ qty: "2", label: "Buy 2+", discountType: "percentage", value: "10" }]);

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
            ← All Offers
          </button>
          <h1 className="b-page-title">New Discount Offer</h1>
        </div>
      </div>

      <Form method="POST">
        <div className="b-stack b-stack-4">

          {/* Discount Type card */}
          <div className="b-card">
            <div className="b-card-header">Discount Type</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">
                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_discountSubtype"
                    checked={discountSubtype === "cart"}
                    onChange={() => setDiscountSubtype("cart")}
                  />
                  <span>
                    <span className="b-checkbox-label">Cart Discount</span>
                    <span className="b-checkbox-help">Discount when cart total reaches a threshold</span>
                  </span>
                </label>
                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_discountSubtype"
                    checked={discountSubtype === "volume"}
                    onChange={() => setDiscountSubtype("volume")}
                  />
                  <span>
                    <span className="b-checkbox-label">Volume Discount</span>
                    <span className="b-checkbox-help">Tiered discounts by quantity</span>
                  </span>
                </label>
                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_discountSubtype"
                    checked={discountSubtype === "cheapest_item"}
                    onChange={() => setDiscountSubtype("cheapest_item")}
                  />
                  <span>
                    <span className="b-checkbox-label">Cheapest Item Free / Discounted</span>
                    <span className="b-checkbox-help">Apply a discount to the lowest-priced item in cart</span>
                  </span>
                </label>
                <input type="hidden" name="discountSubtype" value={discountSubtype} />
              </div>
            </div>
          </div>

          {/* Offer Details card */}
          <div className="b-card">
            <div className="b-card-header">Offer Details</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">
                <div>
                  <label className="b-label" htmlFor="internalName">Internal Name</label>
                  <input
                    id="internalName"
                    className="b-input"
                    name="internalName"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="publicTitle">Public Title</label>
                  <input
                    id="publicTitle"
                    className="b-input"
                    name="publicTitle"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="b-label" htmlFor="currencyCode">Currency Code</label>
                  <input
                    id="currencyCode"
                    className="b-input"
                    name="currencyCode"
                    defaultValue="USD"
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Cart Threshold card — shown for "cart" subtype */}
          {discountSubtype === "cart" && (
            <div className="b-card">
              <div className="b-card-header">Cart Threshold</div>
              <div className="b-card-body">
                <div className="b-stack b-stack-3">
                  <div>
                    <label className="b-label" htmlFor="threshold">Minimum cart value</label>
                    <div className="b-relative" style={{ display: "flex", alignItems: "center" }}>
                      <span className="b-text-sub" style={{ position: "absolute", left: 12, pointerEvents: "none" }}>$</span>
                      <input
                        id="threshold"
                        className="b-input"
                        name="threshold"
                        type="number"
                        style={{ paddingLeft: 28 }}
                        autoComplete="off"
                      />
                    </div>
                    <p className="b-help">Cart must reach this value to qualify</p>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="discountType">Discount type</label>
                    <select
                      id="discountType"
                      className="b-select"
                      name="discountType"
                      value={discountType}
                      onChange={(e) => setDiscountType(e.target.value)}
                    >
                      <option value="percentage">Percentage off cart</option>
                      <option value="fixed_amount">Fixed amount off cart</option>
                    </select>
                  </div>
                  <div>
                    <label className="b-label" htmlFor="discountValue">
                      {discountType === "percentage" ? "Discount %" : "Discount amount"}
                    </label>
                    <div className="b-relative" style={{ display: "flex", alignItems: "center" }}>
                      <span className="b-text-sub" style={{ position: "absolute", left: 12, pointerEvents: "none" }}>
                        {discountType === "percentage" ? "%" : "$"}
                      </span>
                      <input
                        id="discountValue"
                        className="b-input"
                        name="discountValue"
                        type="number"
                        style={{ paddingLeft: 28 }}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Cheapest Item card */}
          {discountSubtype === "cheapest_item" && (
            <div className="b-card">
              <div className="b-card-header">Cheapest Item Discount</div>
              <div className="b-card-body">
                <div className="b-stack b-stack-3">
                  <div>
                    <label className="b-label" htmlFor="cheapestDiscountType">Discount type</label>
                    <select
                      id="cheapestDiscountType"
                      className="b-select"
                      name="discountType"
                      value={discountType}
                      onChange={(e) => setDiscountType(e.target.value)}
                    >
                      <option value="free">Cheapest item free (100%)</option>
                      <option value="percentage">Percentage off cheapest item</option>
                      <option value="fixed_amount">Fixed amount off cheapest item</option>
                    </select>
                  </div>
                  {discountType !== "free" && (
                    <div>
                      <label className="b-label" htmlFor="cheapestDiscountValue">Discount value</label>
                      <input
                        id="cheapestDiscountValue"
                        className="b-input"
                        name="discountValue"
                        type="number"
                        autoComplete="off"
                      />
                    </div>
                  )}
                  {discountType === "free" && (
                    <input type="hidden" name="discountValue" value="100" />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Volume Discount Tiers card */}
          {discountSubtype === "volume" && (
            <div className="b-card">
              <div className="b-card-header">Volume Discount Tiers</div>
              <div className="b-card-body">
                <p className="b-text-sm b-text-sub b-mb-4">
                  Define quantity tiers. Customers see the applicable tier on the product page.
                </p>
                <div className="b-stack b-stack-3">
                  {tiers.map((tier, i) => (
                    <div key={i} className="b-grid-3" style={{ gridTemplateColumns: "100px 1fr 120px 32px", gap: 12 }}>
                      <div>
                        <label className="b-label">Min qty</label>
                        <input
                          className="b-input"
                          name="tier_qty[]"
                          value={tier.qty}
                          type="number"
                          autoComplete="off"
                          onChange={(e) => {
                            const t = [...tiers];
                            t[i] = { ...t[i]!, qty: e.target.value };
                            setTiers(t);
                          }}
                        />
                      </div>
                      <div>
                        <label className="b-label">Label</label>
                        <input
                          className="b-input"
                          name="tier_label[]"
                          value={tier.label}
                          autoComplete="off"
                          onChange={(e) => {
                            const t = [...tiers];
                            t[i] = { ...t[i]!, label: e.target.value };
                            setTiers(t);
                          }}
                        />
                      </div>
                      <div>
                        <label className="b-label">Discount %</label>
                        <input
                          className="b-input"
                          name="tier_discount_value[]"
                          value={tier.value}
                          type="number"
                          autoComplete="off"
                          onChange={(e) => {
                            const t = [...tiers];
                            t[i] = { ...t[i]!, value: e.target.value };
                            setTiers(t);
                          }}
                        />
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end" }}>
                        <button
                          type="button"
                          className="b-btn-icon b-btn-icon-red"
                          title="Remove tier"
                          onClick={() => setTiers(tiers.filter((_, idx) => idx !== i))}
                        >
                          ×
                        </button>
                      </div>
                      <input type="hidden" name="tier_discount_type[]" value="percentage" />
                    </div>
                  ))}

                  <div>
                    <button
                      type="button"
                      className="b-btn b-btn-secondary b-btn-sm"
                      onClick={() =>
                        setTiers([...tiers, { qty: "", label: "", discountType: "percentage", value: "" }])
                      }
                    >
                      + Add Tier
                    </button>
                  </div>
                </div>
                <input type="hidden" name="discountType" value="percentage" />
                <input type="hidden" name="discountValue" value="0" />
              </div>
            </div>
          )}

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
              Create Discount Offer
            </button>
          </div>

        </div>
      </Form>
    </div>
  );
}
