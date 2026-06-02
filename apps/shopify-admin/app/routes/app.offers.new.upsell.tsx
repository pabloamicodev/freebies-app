/**
 * Upsell Offer Builder — FBT, checkout upsell, and thank-you page upsell.
 */

import { Form, useNavigate } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  RadioButton, Button, Text, BlockStack, InlineStack, Checkbox,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

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

  return Response.redirect(`/app/offers/${newOffer.id}`, 302);
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
    <Page title="New Upsell Offer" backAction={{ content: "All Offers", url: "/app/offers" }}>
      <Layout>
        <Layout.Section>
          <Form method="POST">
            <BlockStack gap="500">
              <LegacyCard title="Upsell Type" sectioned>
                <BlockStack gap="300">
                  <RadioButton label="Frequently Bought Together — product page widget" checked={upsellType === "fbt"}
                    onChange={() => setUpsellType("fbt")} id="type-fbt"
                    helpText="Amazon-style 'frequently bought together' widget on product pages." />
                  <RadioButton label="Checkout Upsell — inject widget at checkout (Plus)" checked={upsellType === "checkout"}
                    onChange={() => setUpsellType("checkout")} id="type-checkout"
                    helpText="Shopify Plus only. Show upsell at any checkout step." />
                  <RadioButton label="Thank-You Page Upsell — post-purchase (Plus)" checked={upsellType === "thank_you"}
                    onChange={() => setUpsellType("thank_you")} id="type-ty"
                    helpText="Shopify Plus only. Show upsell after order is placed." />
                  <input type="hidden" name="upsellType" value={upsellType} />
                </BlockStack>
              </LegacyCard>

              <LegacyCard title="Upsell Details" sectioned>
                <FormLayout>
                  <TextField label="Internal Name" name="internalName" autoComplete="off" />
                  <TextField label="Public Title" name="publicTitle" autoComplete="off"
                    placeholder="You might also like..." />
                  <TextField label="Button Text" name="buttonText" defaultValue="Add to Cart" autoComplete="off" />
                  <TextField label="Max Products to Show" name="maxProducts" type="number" defaultValue="3" autoComplete="off" />
                </FormLayout>
              </LegacyCard>

              {upsellType === "fbt" && (
                <LegacyCard title="FBT Layout" sectioned>
                  <FormLayout>
                    <Select
                      label="Layout style"
                      name="fbtLayout"
                      options={[
                        { label: "Amazon-style (horizontal)", value: "amazon" },
                        { label: "Stacked (vertical)", value: "stacked" },
                      ]}
                    />
                  </FormLayout>
                </LegacyCard>
              )}

              {(upsellType === "checkout" || upsellType === "thank_you") && (
                <LegacyCard title="Checkout Placement (Shopify Plus)" sectioned>
                  <FormLayout>
                    <Select label="Target surface" name="checkoutTarget" options={CHECKOUT_TARGETS} />
                  </FormLayout>
                </LegacyCard>
              )}

              <LegacyCard title="Upsell Products" sectioned>
                <FormLayout>
                  <TextField
                    label="Product Variant GIDs (one per line)"
                    name="upsellVariantGids"
                    multiline={4}
                    autoComplete="off"
                    placeholder={"gid://shopify/ProductVariant/12345\ngid://shopify/ProductVariant/67890"}
                    helpText="Products to recommend. For FBT and checkout upsell."
                  />
                </FormLayout>
              </LegacyCard>

              <LegacyCard title="Discount" sectioned>
                <FormLayout>
                  <Select label="Discount type" name="discountType"
                    options={[
                      { label: "No discount", value: "fixed_price" },
                      { label: "Percentage off", value: "percentage" },
                      { label: "Fixed amount off", value: "fixed_amount" },
                    ]}
                    value={discountType} onChange={setDiscountType} />
                  {discountType !== "fixed_price" && (
                    <FormLayout.Group>
                      <TextField label="Discount value" name="discountValue" type="number" autoComplete="off"
                        prefix={discountType === "percentage" ? "%" : "$"} />
                      <TextField label="Currency" name="currencyCode" defaultValue="USD" autoComplete="off" />
                    </FormLayout.Group>
                  )}
                  {discountType === "fixed_price" && <input type="hidden" name="discountValue" value="0" />}
                </FormLayout>
              </LegacyCard>

              <InlineStack align="end" gap="300">
                <Button onClick={() => navigate("/app/offers")}>Cancel</Button>
                <Button variant="primary" submit>Create Upsell Offer</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
