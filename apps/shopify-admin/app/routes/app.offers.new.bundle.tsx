/**
 * Bundle Offer Builder — classic bundle and mix & match.
 * Creates a bundle offer with product selections, discount, and optional bundle page.
 */

import { Form, useNavigate } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  RadioButton, Button, Text, BlockStack, InlineStack, Badge,
  Banner, Checkbox, Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import {
  offers, offerConditions, offerRewards, offerCombinationPolicies,
  bundleDefinitions, bundleSteps, bundleTiers,
} from "@promo/db";
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

  return (
    <Page
      title="New Bundle Offer"
      backAction={{ content: "All Offers", url: "/app/offers" }}
    >
      <Layout>
        <Layout.Section>
          <Form method="POST">
            <BlockStack gap="500">
              <LegacyCard title="Bundle Type" sectioned>
                <BlockStack gap="300">
                  <RadioButton
                    label="Classic Bundle — fixed set of products at a discount"
                    checked={bundleType === "classic"}
                    onChange={() => setBundleType("classic")}
                    id="type-classic"
                    helpText="E.g. 'Buy Product A + Product B for 20% off'"
                  />
                  <RadioButton
                    label="Mix & Match — customer picks from a product list"
                    checked={bundleType === "mix_match"}
                    onChange={() => setBundleType("mix_match")}
                    id="type-mix"
                    helpText="E.g. 'Pick any 3 products for 15% off'"
                  />
                  <RadioButton
                    label="Bundle Page — multi-step build-a-box"
                    checked={bundleType === "bundle_page"}
                    onChange={() => setBundleType("bundle_page")}
                    id="type-page"
                    helpText="Custom bundle builder page with steps"
                  />
                  <input type="hidden" name="bundleType" value={bundleType} />
                </BlockStack>
              </LegacyCard>

              <LegacyCard title="Bundle Details" sectioned>
                <FormLayout>
                  <TextField label="Internal Name" name="internalName" autoComplete="off" />
                  <TextField label="Customer-Facing Title" name="publicTitle" autoComplete="off" />
                  <TextField label="Description (optional)" name="description" autoComplete="off" multiline={2} />
                  <TextField label="Currency" name="currencyCode" defaultValue="USD" autoComplete="off" />
                </FormLayout>
              </LegacyCard>

              <LegacyCard title="Step Configuration" sectioned>
                <FormLayout>
                  <TextField
                    label="Min items per step"
                    name="stepMinQty"
                    type="number"
                    defaultValue="1"
                    autoComplete="off"
                  />
                  <TextField
                    label="Max items per step (leave empty for unlimited)"
                    name="stepMaxQty"
                    type="number"
                    autoComplete="off"
                  />
                  <Checkbox
                    label="Enable product search in bundle step"
                    name="searchEnabled"
                  />
                </FormLayout>
                <Text as="p" tone="subdued" variant="bodySm">
                  Note: Product selection is configured on the offer detail page after creation.
                </Text>
              </LegacyCard>

              <LegacyCard title="Discount" sectioned>
                <FormLayout>
                  <Checkbox
                    label="Use quantity tiers (different discount at different quantities)"
                    checked={useTiers}
                    onChange={setUseTiers}
                  />

                  {!useTiers && (
                    <>
                      <Select
                        label="Discount type"
                        name="discountType"
                        options={[
                          { label: "Percentage off all bundle products", value: "percentage" },
                          { label: "Fixed amount off bundle total", value: "fixed_amount" },
                          { label: "Fixed price for bundle", value: "fixed_price" },
                          { label: "Free gift included in bundle", value: "free" },
                          { label: "Free shipping", value: "free_shipping" },
                        ]}
                        value={discountType}
                        onChange={setDiscountType}
                      />
                      <TextField
                        label="Discount value"
                        name="discountValue"
                        type="number"
                        autoComplete="off"
                        prefix={discountType === "percentage" ? "%" : "$"}
                      />
                    </>
                  )}

                  {useTiers && (
                    <BlockStack gap="300">
                      <input type="hidden" name="discountType" value="percentage" />
                      <input type="hidden" name="discountValue" value="0" />
                      {tiers.map((tier, i) => (
                        <InlineStack key={i} gap="300">
                          <TextField label="Min qty" name="tier_qty[]" value={tier.qty}
                            onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, qty: v }; setTiers(t); }}
                            type="number" autoComplete="off" />
                          <TextField label="Label" name="tier_label[]" value={tier.label}
                            onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, label: v }; setTiers(t); }}
                            autoComplete="off" />
                          <TextField label="% Discount" name="tier_value[]" value={tier.value}
                            onChange={(v) => { const t = [...tiers]; t[i] = { ...t[i]!, value: v }; setTiers(t); }}
                            type="number" autoComplete="off" />
                        </InlineStack>
                      ))}
                      <Button onClick={() => setTiers([...tiers, { qty: "", label: "", value: "" }])}>
                        + Add Tier
                      </Button>
                    </BlockStack>
                  )}
                </FormLayout>
              </LegacyCard>

              <LegacyCard title="Combination Policy" sectioned>
                <BlockStack gap="200">
                  <Checkbox label="Combines with order discounts" name="combines_order" />
                  <Checkbox label="Combines with shipping discounts" name="combines_shipping" />
                </BlockStack>
              </LegacyCard>

              <InlineStack align="end" gap="300">
                <Button onClick={() => navigate("/app/offers")}>Cancel</Button>
                <Button variant="primary" submit>Create Bundle Offer</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
