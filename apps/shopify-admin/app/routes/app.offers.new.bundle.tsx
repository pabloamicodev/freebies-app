/**
 * Bundle Offer Builder — classic bundle and mix & match.
 * Creates a bundle offer with product selections, discount, and optional bundle page.
 */

import { Form, useNavigate } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import {
  offers, offerConditions, offerRewards, offerCombinationPolicies,
  bundleDefinitions, bundleSteps, bundleTiers,
} from "@promo/db";
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

  const bundleType = formData.get("bundleType") as string;
  const internalName = formData.get("internalName") as string;
  const publicTitle = formData.get("publicTitle") as string;
  const description = formData.get("description") as string;
  const discountType = formData.get("discountType") as string;
  const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
  const currencyCode = (formData.get("currencyCode") as string) || "USD";
  const combinesWithOrderDiscounts = formData.get("combines_order") === "on";
  const combinesWithShippingDiscounts = formData.get("combines_shipping") === "on";

  // Create offer
  const [newOffer] = await db.insert(offers).values({
    shopId, type: "bundle", status: "draft",
    internalName, publicTitle, description: description || null, priority: 100,
  }).returning({ id: offers.id });

  if (!newOffer) return { error: "Failed to create offer" };

  // Create combination policy
  await db.insert(offerCombinationPolicies).values({
    shopId, offerId: newOffer.id,
    combinesWithOrderDiscounts,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  });

  // Create bundle definition
  const [bundleDef] = await db.insert(bundleDefinitions).values({
    shopId, offerId: newOffer.id,
    bundleType,
    title: publicTitle,
    description: description || null,
    layoutMode: bundleType === "bundle_page" ? (formData.get("layoutMode") as string) ?? "all_steps_one_page" : "all_steps_one_page",
    createBundleProduct: formData.get("createBundleProduct") === "on",
    config: {},
  }).returning({ id: bundleDefinitions.id });

  // Create bundle step (at least one, with product selections)
  if (bundleDef) {
    await db.insert(bundleSteps).values({
      shopId, bundleId: bundleDef.id,
      title: "Step 1 — Select Products",
      sourceType: "products",
      sourceConfig: { productGids: [] }, // Merchant adds via product picker
      minQuantity: parseInt(formData.get("stepMinQty") as string, 10) || 1,
      maxQuantity: formData.get("stepMaxQty") ? parseInt(formData.get("stepMaxQty") as string, 10) : null,
      searchEnabled: formData.get("searchEnabled") === "on",
      sortOptions: [],
      filterOptions: [],
      sortOrder: 0,
    });

    // Create tiers if provided
    const tierQtys = formData.getAll("tier_qty[]") as string[];
    const tierLabels = formData.getAll("tier_label[]") as string[];
    const tierValues = formData.getAll("tier_value[]") as string[];

    for (let i = 0; i < tierQtys.length; i++) {
      const qty = parseInt(tierQtys[i] ?? "0", 10);
      if (qty > 0) {
        await db.insert(bundleTiers).values({
          shopId, bundleId: bundleDef.id,
          minQuantity: qty,
          label: tierLabels[i] ?? "",
          discountType: discountType as any,
          value: { amount: parseFloat(tierValues[i] ?? "0"), currencyCode },
          sortOrder: i,
        });
      }
    }
  }

  // Create bundle reward
  await db.insert(offerRewards).values({
    shopId, offerId: newOffer.id,
    rewardType: "bundle_discount",
    discountType: discountType as any,
    value: {
      amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100),
      currencyCode,
    },
    target: { scope: "bundle_components" },
    quantity: null,
    isAutoAdd: false,
    isCustomerSelectable: false,
    sortOrder: 0,
    label: null,
  });

  return Response.redirect(`/app/offers/${newOffer.id}`, 302);
};

export default function NewBundleOfferPage() {
  const navigate = useNavigate();
  const [bundleType, setBundleType] = useState<"classic" | "mix_match" | "bundle_page">("classic");
  const [discountType, setDiscountType] = useState("percentage");
  const [tiers, setTiers] = useState([{ qty: "3", label: "Buy 3+", value: "10" }]);
  const [useTiers, setUseTiers] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(false);

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
          <h1 className="b-page-title">New Bundle Offer</h1>
          <span className="b-badge b-badge-gray">draft</span>
        </div>
      </div>

      <Form method="POST">
        <div className="b-stack b-stack-4">

          {/* Bundle Type */}
          <div className="b-card">
            <div className="b-card-header">Bundle Type</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_bundleTypeRadio"
                    checked={bundleType === "classic"}
                    onChange={() => setBundleType("classic")}
                    style={{ marginTop: 2, flexShrink: 0, accentColor: "var(--blue)", width: 16, height: 16, cursor: "pointer" }}
                  />
                  <div>
                    <div className="b-checkbox-label">Classic Bundle — fixed set of products at a discount</div>
                    <div className="b-checkbox-help">E.g. "Buy Product A + Product B for 20% off"</div>
                  </div>
                </label>

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_bundleTypeRadio"
                    checked={bundleType === "mix_match"}
                    onChange={() => setBundleType("mix_match")}
                    style={{ marginTop: 2, flexShrink: 0, accentColor: "var(--blue)", width: 16, height: 16, cursor: "pointer" }}
                  />
                  <div>
                    <div className="b-checkbox-label">Mix &amp; Match — customer picks from a product list</div>
                    <div className="b-checkbox-help">E.g. "Pick any 3 products for 15% off"</div>
                  </div>
                </label>

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="_bundleTypeRadio"
                    checked={bundleType === "bundle_page"}
                    onChange={() => setBundleType("bundle_page")}
                    style={{ marginTop: 2, flexShrink: 0, accentColor: "var(--blue)", width: 16, height: 16, cursor: "pointer" }}
                  />
                  <div>
                    <div className="b-checkbox-label">Bundle Page — multi-step build-a-box</div>
                    <div className="b-checkbox-help">Custom bundle builder page with steps</div>
                  </div>
                </label>

                <input type="hidden" name="bundleType" value={bundleType} />
              </div>
            </div>
          </div>

          {/* Bundle Details */}
          <div className="b-card">
            <div className="b-card-header">Bundle Details</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">

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
                  <label className="b-label" htmlFor="publicTitle">Customer-Facing Title</label>
                  <input
                    id="publicTitle"
                    className="b-input"
                    type="text"
                    name="publicTitle"
                    autoComplete="off"
                  />
                </div>

                <div>
                  <label className="b-label" htmlFor="description">Description (optional)</label>
                  <textarea
                    id="description"
                    className="b-input"
                    name="description"
                    autoComplete="off"
                    rows={2}
                    style={{ resize: "vertical" }}
                  />
                </div>

                <div>
                  <label className="b-label" htmlFor="currencyCode">Currency</label>
                  <input
                    id="currencyCode"
                    className="b-input"
                    type="text"
                    name="currencyCode"
                    defaultValue="USD"
                    autoComplete="off"
                  />
                </div>

              </div>
            </div>
          </div>

          {/* Step Configuration */}
          <div className="b-card">
            <div className="b-card-header">Step Configuration</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">

                <div className="b-grid-2">
                  <div>
                    <label className="b-label" htmlFor="stepMinQty">Min items per step</label>
                    <input
                      id="stepMinQty"
                      className="b-input"
                      type="number"
                      name="stepMinQty"
                      defaultValue="1"
                      min="1"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="b-label" htmlFor="stepMaxQty">Max items per step</label>
                    <input
                      id="stepMaxQty"
                      className="b-input"
                      type="number"
                      name="stepMaxQty"
                      autoComplete="off"
                    />
                    <p className="b-help">Leave empty for unlimited</p>
                  </div>
                </div>

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    name="searchEnabled"
                    checked={searchEnabled}
                    onChange={(e) => setSearchEnabled(e.target.checked)}
                  />
                  <span className="b-checkbox-label">Enable product search in bundle step</span>
                </label>

                <p className="b-text-sm b-text-sub" style={{ margin: 0 }}>
                  Product selection is configured on the offer detail page after creation.
                </p>

              </div>
            </div>
          </div>

          {/* Discount */}
          <div className="b-card">
            <div className="b-card-header">Discount</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-3">

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={useTiers}
                    onChange={(e) => setUseTiers(e.target.checked)}
                  />
                  <span className="b-checkbox-label">Use quantity tiers (different discount at different quantities)</span>
                </label>

                {!useTiers && (
                  <>
                    <div>
                      <label className="b-label" htmlFor="discountType">Discount type</label>
                      <select
                        id="discountType"
                        className="b-select"
                        name="discountType"
                        value={discountType}
                        onChange={(e) => setDiscountType(e.target.value)}
                      >
                        <option value="percentage">Percentage off all bundle products</option>
                        <option value="fixed_amount">Fixed amount off bundle total</option>
                        <option value="fixed_price">Fixed price for bundle</option>
                        <option value="free">Free gift included in bundle</option>
                        <option value="free_shipping">Free shipping</option>
                      </select>
                    </div>

                    <div>
                      <label className="b-label" htmlFor="discountValue">Discount value</label>
                      <div className="b-row" style={{ gap: 0 }}>
                        <span style={{
                          padding: "7px 10px",
                          background: "var(--bg-hover)",
                          border: "1px solid #babec3",
                          borderRight: "none",
                          borderRadius: "var(--r-sm) 0 0 var(--r-sm)",
                          fontSize: 14,
                          color: "var(--text-sub)",
                          flexShrink: 0,
                        }}>
                          {discountType === "percentage" ? "%" : "$"}
                        </span>
                        <input
                          id="discountValue"
                          className="b-input"
                          type="number"
                          name="discountValue"
                          autoComplete="off"
                          style={{ borderRadius: "0 var(--r-sm) var(--r-sm) 0" }}
                        />
                      </div>
                    </div>
                  </>
                )}

                {useTiers && (
                  <div className="b-stack b-stack-3">
                    <input type="hidden" name="discountType" value="percentage" />
                    <input type="hidden" name="discountValue" value="0" />

                    {tiers.map((tier, i) => (
                      <div key={i} className="b-grid-3" style={{ alignItems: "flex-end" }}>
                        <div>
                          <label className="b-label">Min qty</label>
                          <input
                            className="b-input"
                            type="number"
                            name="tier_qty[]"
                            value={tier.qty}
                            onChange={(e) => {
                              const t = [...tiers];
                              t[i] = { ...t[i]!, qty: e.target.value };
                              setTiers(t);
                            }}
                            autoComplete="off"
                          />
                        </div>
                        <div>
                          <label className="b-label">Label</label>
                          <input
                            className="b-input"
                            type="text"
                            name="tier_label[]"
                            value={tier.label}
                            onChange={(e) => {
                              const t = [...tiers];
                              t[i] = { ...t[i]!, label: e.target.value };
                              setTiers(t);
                            }}
                            autoComplete="off"
                          />
                        </div>
                        <div>
                          <label className="b-label">% Discount</label>
                          <input
                            className="b-input"
                            type="number"
                            name="tier_value[]"
                            value={tier.value}
                            onChange={(e) => {
                              const t = [...tiers];
                              t[i] = { ...t[i]!, value: e.target.value };
                              setTiers(t);
                            }}
                            autoComplete="off"
                          />
                        </div>
                      </div>
                    ))}

                    <div>
                      <button
                        type="button"
                        className="b-btn b-btn-secondary b-btn-sm"
                        onClick={() => setTiers([...tiers, { qty: "", label: "", value: "" }])}
                      >
                        + Add Tier
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>

          {/* Combination Policy */}
          <div className="b-card">
            <div className="b-card-header">Combination Policy</div>
            <div className="b-card-body">
              <div className="b-stack b-stack-2">

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" name="combines_order" />
                  <span className="b-checkbox-label">Combines with order discounts</span>
                </label>

                <label className="b-checkbox-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" name="combines_shipping" />
                  <span className="b-checkbox-label">Combines with shipping discounts</span>
                </label>

              </div>
            </div>
          </div>

          {/* Form actions */}
          <div className="b-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="b-btn b-btn-secondary"
              onClick={() => navigate("/app/offers")}
            >
              Cancel
            </button>
            <button type="submit" className="b-btn b-btn-primary">
              Create Bundle Offer
            </button>
          </div>

        </div>
      </Form>
    </div>
  );
}
