/**
 * Offer Rewards Editor — Step 4 of the offer builder wizard.
 * Configure what the customer receives: gift products, discounts, shipping.
 */

import { useLoaderData, useNavigate, useNavigation, useActionData, Form } from "react-router";
import { useState } from "react";
import { NotFound } from "../components/NotFound.js";
import { PageHeader } from "../components/PageHeader.js";
import { ProductPicker } from "../components/ProductPicker.js";
import { authenticate } from "../shopify.server.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { offers, offerRewards } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, rewardRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
  ]);

  return {
    offer: offerRows[0],
    rewards: rewardRows.sort((a, b) => a.sortOrder - b.sortOrder),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "add_reward") {
    const rewardType = formData.get("rewardType") as string;
    const discountType = formData.get("discountType") as string;
    const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
    const quantity = formData.get("quantity") ? parseInt(formData.get("quantity") as string, 10) : null;
    const isAutoAdd = formData.get("isAutoAdd") === "on";
    const isCustomerSelectable = formData.get("isCustomerSelectable") === "on";
    const trackMode = (formData.get("trackMode") as "product" | "variant") ?? "product";
    const label = (formData.get("label") as string) || null;
    const currencyCode = (formData.get("currencyCode") as string) || "USD";

    if (!rewardType) return { error: "Reward type is required." };

    const needsValue = discountType !== "free" && discountType !== "cheapest_item_free" && discountType !== "most_expensive_item_discount";
    if (needsValue && discountValue <= 0) {
      return { error: "Discount value must be greater than 0." };
    }
    if (discountType === "percentage" && discountValue > 100) {
      return { error: "Percentage discount cannot exceed 100%." };
    }

    // Build target from variant GIDs input
    const variantGids = (formData.get("variantGids") as string)
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);

    const target = variantGids.length > 0
      ? { variantIds: variantGids }
      : { scope: "cart" };

    const existing = await db.select({ id: offerRewards.id })
      .from(offerRewards).where(eq(offerRewards.offerId, offerId));

    await db.insert(offerRewards).values({
      shopId, offerId,
      rewardType: rewardType as "product_gift" | "shipping_discount" | "product_discount" | "order_discount" | "bundle_discount" | "upsell_discount",
      discountType: discountType as "percentage" | "fixed_amount" | "fixed_price" | "free" | "cheapest_item_free" | "most_expensive_item_discount",
      value: {
        amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100),
        currencyCode,
      },
      target,
      quantity,
      isAutoAdd,
      isCustomerSelectable,
      trackMode,
      sortOrder: existing.length,
      label,
    });
  }

  if (intent === "delete_reward") {
    const rewardId = formData.get("rewardId") as string;
    if (!rewardId) return { error: "Reward ID missing." };
    await db.delete(offerRewards).where(eq(offerRewards.id, rewardId));
  }

  return { success: true };
};

const REWARD_TYPES = [
  { label: "Product Gift — add a free or discounted product", value: "product_gift" },
  { label: "Order Discount — % or $ off the cart total", value: "order_discount" },
  { label: "Shipping Discount — % or $ off shipping", value: "shipping_discount" },
  { label: "Product Discount — % or $ off specific products", value: "product_discount" },
];

const DISCOUNT_TYPES = [
  { label: "Free (100% off)", value: "free" },
  { label: "Percentage off", value: "percentage" },
  { label: "Fixed amount off", value: "fixed_amount" },
  { label: "Fixed price", value: "fixed_price" },
  { label: "Cheapest item free", value: "cheapest_item_free" },
  { label: "Most expensive item discount", value: "most_expensive_item_discount" },
];

const REWARD_TYPE_LABELS: Record<string, string> = {
  product_gift: "Gift",
  order_discount: "Order",
  shipping_discount: "Shipping",
  product_discount: "Product",
};

export default function OfferRewardsPage() {
  const { offer, rewards } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const isSubmitting = navigation.state !== "idle";
  const [adding, setAdding] = useState(false);
  const [rewardType, setRewardType] = useState("product_gift");
  const [discountType, setDiscountType] = useState("free");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGiftGids, setSelectedGiftGids] = useState<string[]>([]);
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [giftQuantity, setGiftQuantity] = useState("1");

  if (!offer) return <NotFound message="Offer not found." />;

  const needsValue =
    discountType !== "free" &&
    discountType !== "cheapest_item_free" &&
    discountType !== "most_expensive_item_discount";

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Select Gift Products"
        mode="variants"
        allowMultiple
        selectedIds={selectedGiftGids}
        onSelect={setSelectedGiftGids}
      />

      <div className="b-page">
        {/* ── Page header ─────────────────────────────────── */}
        <PageHeader
          title="Rewards / Gifts"
          subtitle={offer.internalName}
          backTo={`/app/offers/${offer.id}/conditions`}
          actions={<button type="button" className="b-btn b-btn-primary" onClick={() => navigate(`/app/offers/${offer.id}`)}>Widget →</button>}
        />

        {/* ── Action error banner ─────────────────────────── */}
        {"error" in (actionData ?? {}) && (actionData as { error: string }).error && (
          <div className="b-banner b-banner-red b-mb-4">
            <span className="b-banner-icon">✕</span>
            <div className="b-banner-body">
              <p className="b-banner-text" style={{ margin: 0 }}>
                {(actionData as { error: string }).error}
              </p>
            </div>
          </div>
        )}

        {/* ── No rewards warning ───────────────────────────── */}
        {rewards.length === 0 && !adding && (
          <div className="b-banner b-banner-orange b-mb-4">
            <span className="b-banner-icon">⚠️</span>
            <div className="b-banner-body">
              <p className="b-banner-title">No rewards configured</p>
              <p className="b-banner-text">
                Add at least one reward before publishing this offer.
              </p>
            </div>
          </div>
        )}

        {/* ── Rewards list ─────────────────────────────────── */}
        <div className="b-card">
          <div className="b-card-header">Rewards</div>
          <div className="b-card-body">
            <div className="b-stack b-stack-3">
              {rewards.map((r) => (
                <div
                  key={r.id}
                  className="b-row-between"
                  style={{
                    padding: "14px 16px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r)",
                    background: "var(--bg-hover)",
                  }}
                >
                  {/* Left: badges + info */}
                  <div className="b-row b-gap-3" style={{ flexWrap: "wrap" }}>
                    <span className="b-badge b-badge-green">
                      {REWARD_TYPE_LABELS[r.rewardType] ?? r.rewardType}
                    </span>
                    <span className="b-text-sm b-text-bold">{r.discountType}</span>
                    {r.quantity != null && (
                      <span className="b-text-sm b-text-sub">Qty: {r.quantity}</span>
                    )}
                    {r.isAutoAdd && (
                      <span className="b-badge b-badge-blue">Auto-add</span>
                    )}
                    {r.isCustomerSelectable && (
                      <span className="b-badge b-badge-orange">Customer selects</span>
                    )}
                  </div>

                  {/* Right: delete button */}
                  <Form method="POST" style={{ flexShrink: 0, marginLeft: 16 }}>
                    <input type="hidden" name="intent" value="delete_reward" />
                    <input type="hidden" name="rewardId" value={r.id} />
                    <button
                      type="submit"
                      className="b-btn-icon b-btn-icon-red"
                      title="Remove reward"
                    >
                      ✕
                    </button>
                  </Form>
                </div>
              ))}

              {rewards.length === 0 && (
                <p className="b-text-sm b-text-muted" style={{ margin: 0 }}>
                  No rewards yet.
                </p>
              )}
            </div>

            {!adding && (
              <button
                type="button"
                className="b-btn b-btn-secondary b-mt-4"
                onClick={() => setAdding(true)}
              >
                + Add Reward
              </button>
            )}
          </div>
        </div>

        {/* ── Add reward form ──────────────────────────────── */}
        {adding && (
          <div className="b-card b-mt-4">
            <div className="b-card-header">Add Reward</div>
            <div className="b-card-body">
              <Form method="POST">
                <input type="hidden" name="intent" value="add_reward" />

                <div className="b-stack b-stack-3">
                  {/* Reward type */}
                  <div>
                    <label className="b-label" htmlFor="rewardType">
                      Reward Type
                    </label>
                    <select
                      id="rewardType"
                      name="rewardType"
                      className="b-select"
                      value={rewardType}
                      onChange={(e) => setRewardType(e.target.value)}
                    >
                      {REWARD_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Discount type */}
                  <div>
                    <label className="b-label" htmlFor="discountType">
                      Discount Type
                    </label>
                    <select
                      id="discountType"
                      name="discountType"
                      className="b-select"
                      value={discountType}
                      onChange={(e) => setDiscountType(e.target.value)}
                    >
                      {DISCOUNT_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Discount value + currency (only when applicable) */}
                  {needsValue && (
                    <div className="b-grid-2">
                      <div>
                        <label className="b-label" htmlFor="discountValue">
                          Discount Value{" "}
                          <span className="b-text-muted">
                            ({discountType === "percentage" ? "%" : "$"})
                          </span>
                        </label>
                        <input
                          id="discountValue"
                          name="discountValue"
                          type="number"
                          className="b-input"
                          min="0"
                          step="0.01"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="b-label" htmlFor="currencyCode">
                          Currency Code
                        </label>
                        <input
                          id="currencyCode"
                          name="currencyCode"
                          type="text"
                          className="b-input"
                          value={currencyCode}
                          onChange={(e) => setCurrencyCode(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                    </div>
                  )}

                  {/* Hidden discount value for fixed/free types */}
                  {(discountType === "free" || discountType === "cheapest_item_free") && (
                    <input type="hidden" name="discountValue" value="100" />
                  )}
                  {discountType === "most_expensive_item_discount" && (
                    <input type="hidden" name="discountValue" value="0" />
                  )}

                  {/* Product gift section */}
                  {rewardType === "product_gift" && (
                    <>
                      <hr className="b-divider" />

                      {/* Product picker */}
                      <div>
                        <p className="b-label" style={{ marginBottom: 8 }}>
                          Gift Products
                        </p>

                        {/* Selected GID tags */}
                        {selectedGiftGids.length > 0 && (
                          <div
                            className="b-row b-gap-2"
                            style={{ flexWrap: "wrap", marginBottom: 10 }}
                          >
                            {selectedGiftGids.map((gid) => (
                              <span
                                key={gid}
                                className="b-badge b-badge-gray b-row b-gap-2"
                                style={{ gap: 6 }}
                              >
                                {gid.split("/").pop()}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSelectedGiftGids((prev) =>
                                      prev.filter((g) => g !== gid)
                                    )
                                  }
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: 0,
                                    lineHeight: 1,
                                    color: "var(--text-sub)",
                                    fontSize: 12,
                                  }}
                                  title="Remove"
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        <button
                          type="button"
                          className="b-btn b-btn-secondary b-btn-sm"
                          onClick={() => setPickerOpen(true)}
                        >
                          🎁 Select Gift Products
                        </button>
                        <input
                          type="hidden"
                          name="variantGids"
                          value={selectedGiftGids.join("\n")}
                        />
                      </div>

                      {/* Manual GID fallback */}
                      <div>
                        <label className="b-label" htmlFor="variantGidsManual">
                          Or paste GIDs manually (one per line)
                        </label>
                        <textarea
                          id="variantGidsManual"
                          name="variantGidsManual"
                          className="b-input"
                          rows={2}
                          autoComplete="off"
                          placeholder="gid://shopify/ProductVariant/12345"
                          style={{ resize: "vertical" }}
                        />
                        <p className="b-help">
                          Optional: paste GIDs directly if you know them.
                        </p>
                      </div>

                      {/* Gift quantity */}
                      <div>
                        <label className="b-label" htmlFor="quantity">
                          Gift Quantity
                        </label>
                        <input
                          id="quantity"
                          name="quantity"
                          type="number"
                          className="b-input"
                          value={giftQuantity}
                          onChange={(e) => setGiftQuantity(e.target.value)}
                          min="1"
                          autoComplete="off"
                        />
                      </div>

                      {/* Track mode */}
                      <div>
                        <label className="b-label" htmlFor="trackMode">
                          Track Mode
                        </label>
                        <select
                          id="trackMode"
                          name="trackMode"
                          className="b-select"
                          defaultValue="product"
                        >
                          <option value="product">
                            Track by Product (any variant counts)
                          </option>
                          <option value="variant">
                            Track by Variant (exact variant only)
                          </option>
                        </select>
                      </div>

                      {/* Auto-add */}
                      <label className="b-checkbox-row">
                        <input
                          type="checkbox"
                          name="isAutoAdd"
                        />
                        <div>
                          <span className="b-checkbox-label">
                            Auto-add gift to cart
                          </span>
                          <p className="b-checkbox-help">
                            Gift is automatically added when offer qualifies. Uncheck to show gift slider.
                          </p>
                        </div>
                      </label>

                      {/* Customer selectable */}
                      <label className="b-checkbox-row">
                        <input
                          type="checkbox"
                          name="isCustomerSelectable"
                        />
                        <div>
                          <span className="b-checkbox-label">
                            Customer selectable
                          </span>
                          <p className="b-checkbox-help">
                            Customer can choose this gift from the gift slider.
                          </p>
                        </div>
                      </label>
                    </>
                  )}

                  {/* Label */}
                  <div>
                    <label className="b-label" htmlFor="label">
                      Label{" "}
                      <span className="b-text-muted b-text-xs">(optional)</span>
                    </label>
                    <input
                      id="label"
                      name="label"
                      type="text"
                      className="b-input"
                      autoComplete="off"
                      placeholder="e.g. 'Choose your gift'"
                    />
                  </div>

                  {/* Form actions */}
                  <div className="b-row b-gap-3 b-mt-2">
                    <button
                      type="submit"
                      className="b-btn b-btn-primary"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? "Adding…" : "Add Reward"}
                    </button>
                    <button
                      type="button"
                      className="b-btn b-btn-secondary"
                      onClick={() => setAdding(false)}
                      disabled={isSubmitting}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Form>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
