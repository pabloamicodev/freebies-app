/**
 * Discount offer builder — volume discount, cart discount, cheapest item free.
 * Creates offers with discount_type conditions and rewards.
 */

import { Form, useNavigate } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  RadioButton, Button, Text, BlockStack, InlineStack, Banner,
  Checkbox,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

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

  return Response.redirect(`/app/offers/${newOffer.id}`, 302);
};

export default function NewDiscountOfferPage() {
  const navigate = useNavigate();
  const [discountSubtype, setDiscountSubtype] = useState<"volume" | "cart" | "cheapest_item">("cart");
  const [discountType, setDiscountType] = useState("percentage");
  const [tiers, setTiers] = useState([{ qty: "2", label: "Buy 2+", discountType: "percentage", value: "10" }]);

  return (
    <Page
      title="New Discount Offer"
      backAction={{ content: "All Offers", url: "/app/offers" }}
    >
      <Layout>
        <Layout.Section>
          <Form method="POST">
            <BlockStack gap="500">
              <LegacyCard title="Discount Type" sectioned>
                <BlockStack gap="300">
                  <RadioButton
                    label="Cart Discount — discount when cart total reaches a threshold"
                    checked={discountSubtype === "cart"}
                    onChange={() => setDiscountSubtype("cart")}
                    id="type-cart"
                  />
                  <RadioButton
                    label="Volume Discount — tiered discounts by quantity"
                    checked={discountSubtype === "volume"}
                    onChange={() => setDiscountSubtype("volume")}
                    id="type-volume"
                  />
                  <RadioButton
                    label="Cheapest Item Free / Discounted"
                    checked={discountSubtype === "cheapest_item"}
                    onChange={() => setDiscountSubtype("cheapest_item")}
                    id="type-cheapest"
                  />
                  <input type="hidden" name="discountSubtype" value={discountSubtype} />
                </BlockStack>
              </LegacyCard>

              <LegacyCard title="Offer Details" sectioned>
                <FormLayout>
                  <TextField label="Internal Name" name="internalName" autoComplete="off" />
                  <TextField label="Public Title" name="publicTitle" autoComplete="off" />
                  <TextField label="Currency Code" name="currencyCode" defaultValue="USD" autoComplete="off" />
                </FormLayout>
              </LegacyCard>

              {(discountSubtype === "cart") && (
                <LegacyCard title="Cart Threshold" sectioned>
                  <FormLayout>
                    <TextField
                      label="Minimum cart value"
                      name="threshold"
                      type="number"
                      prefix="$"
                      helpText="Cart must reach this value to qualify"
                      autoComplete="off"
                    />
                    <Select
                      label="Discount type"
                      name="discountType"
                      options={[
                        { label: "Percentage off cart", value: "percentage" },
                        { label: "Fixed amount off cart", value: "fixed_amount" },
                      ]}
                      value={discountType}
                      onChange={setDiscountType}
                    />
                    <TextField
                      label={discountType === "percentage" ? "Discount %" : "Discount amount"}
                      name="discountValue"
                      type="number"
                      prefix={discountType === "percentage" ? "%" : "$"}
                      autoComplete="off"
                    />
                  </FormLayout>
                </LegacyCard>
              )}

              {discountSubtype === "cheapest_item" && (
                <LegacyCard title="Cheapest Item Discount" sectioned>
                  <FormLayout>
                    <Select
                      label="Discount type"
                      name="discountType"
                      options={[
                        { label: "Cheapest item free (100%)", value: "free" },
                        { label: "Percentage off cheapest item", value: "percentage" },
                        { label: "Fixed amount off cheapest item", value: "fixed_amount" },
                      ]}
                      value={discountType}
                      onChange={setDiscountType}
                    />
                    {discountType !== "free" && (
                      <TextField
                        label="Discount value"
                        name="discountValue"
                        type="number"
                        autoComplete="off"
                      />
                    )}
                    {discountType === "free" && <input type="hidden" name="discountValue" value="100" />}
                  </FormLayout>
                </LegacyCard>
              )}

              {discountSubtype === "volume" && (
                <LegacyCard title="Volume Discount Tiers" sectioned>
                  <Text as="p" tone="subdued">
                    Define quantity tiers. Customers see the applicable tier on the product page.
                  </Text>
                  <BlockStack gap="300">
                    {tiers.map((tier, i) => (
                      <InlineStack key={i} gap="300" align="start">
                        <TextField
                          label="Min qty"
                          name="tier_qty[]"
                          value={tier.qty}
                          onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, qty: v }; setTiers(t); }}
                          type="number"
                          autoComplete="off"
                        />
                        <TextField
                          label="Label"
                          name="tier_label[]"
                          value={tier.label}
                          onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, label: v }; setTiers(t); }}
                          autoComplete="off"
                        />
                        <TextField
                          label="Discount %"
                          name="tier_discount_value[]"
                          value={tier.value}
                          onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, value: v }; setTiers(t); }}
                          type="number"
                          autoComplete="off"
                        />
                        <input type="hidden" name="tier_discount_type[]" value="percentage" />
                      </InlineStack>
                    ))}
                    <Button onClick={() => setTiers([...tiers, { qty: "", label: "", discountType: "percentage", value: "" }])}>
                      + Add Tier
                    </Button>
                  </BlockStack>
                  <input type="hidden" name="discountType" value="percentage" />
                  <input type="hidden" name="discountValue" value="0" />
                </LegacyCard>
              )}

              <InlineStack align="end" gap="300">
                <Button onClick={() => navigate("/app/offers")}>Cancel</Button>
                <Button variant="primary" submit>Create Discount Offer</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
