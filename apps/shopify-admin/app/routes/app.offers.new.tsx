import { useState } from "react";
import { useNavigate, useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, ButtonGroup, ProgressBar, Text, InlineStack, BlockStack,
  Banner, Checkbox, RadioButton, Divider, Box,
  Badge, Modal, ResourceList, Thumbnail,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where((await import("drizzle-orm")).eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);

  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const offerType = formData.get("offerType") as string;
  const internalName = formData.get("internalName") as string;
  const publicTitle = formData.get("publicTitle") as string;
  const priority = parseInt(formData.get("priority") as string, 10) || 100;

  // Validation
  if (!internalName || !publicTitle || !offerType) {
    return { error: "Internal name, public title, and type are required" };
  }

  // Create offer in draft status
  const [newOffer] = await db
    .insert(offers)
    .values({
      shopId,
      type: offerType as any,
      status: "draft",
      internalName,
      publicTitle,
      priority,
    })
    .returning({ id: offers.id });

  if (!newOffer) return { error: "Failed to create offer" };

  // Create default combination policy
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

  // Redirect to offer edit page (full wizard)
  return Response.redirect(`/app/offers/${newOffer.id}`, 302);
};

const OFFER_TYPES = [
  { label: "🎁 Gift Offer — Free gift with purchase", value: "gift" },
  { label: "📦 Bundle Offer — Classic bundle or build-a-box", value: "bundle" },
  { label: "⬆️ Upsell Offer — Checkout or FBT upsell", value: "upsell" },
  { label: "💰 Discount Offer — Volume, cart, or cheapest item", value: "discount" },
  { label: "🚀 Booster — Today Offer widget or progress bar", value: "booster" },
];

export default function NewOfferPage() {
  const navigate = useNavigate();
  const [offerType, setOfferType] = useState("gift");
  const [internalName, setInternalName] = useState("");
  const [publicTitle, setPublicTitle] = useState("");
  const [priority, setPriority] = useState("100");
  const [error, setError] = useState("");

  function validate() {
    if (!internalName.trim()) { setError("Internal name is required"); return false; }
    if (!publicTitle.trim()) { setError("Public title is required"); return false; }
    if (isNaN(parseInt(priority, 10))) { setError("Priority must be a number"); return false; }
    setError("");
    return true;
  }

  return (
    <Page
      title="Create New Offer"
      backAction={{ content: "All Offers", url: "/app/offers" }}
    >
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Validation Error">
              <p>{error}</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Form method="POST" onSubmit={(e) => { if (!validate()) e.preventDefault(); }}>
            <BlockStack gap="500">
              <LegacyCard title="Offer Type" sectioned>
                <BlockStack gap="300">
                  {OFFER_TYPES.map((type) => (
                    <RadioButton
                      key={type.value}
                      label={type.label}
                      checked={offerType === type.value}
                      onChange={() => setOfferType(type.value)}
                      id={`type-${type.value}`}
                    />
                  ))}
                  <input type="hidden" name="offerType" value={offerType} />
                </BlockStack>
              </LegacyCard>

              <LegacyCard title="Offer Details" sectioned>
                <FormLayout>
                  <TextField
                    label="Internal Name"
                    helpText="Used internally to identify this offer. Must be unique."
                    value={internalName}
                    onChange={setInternalName}
                    name="internalName"
                    autoComplete="off"
                    placeholder="e.g., free-gift-50-usd-cart"
                  />
                  <TextField
                    label="Public Title"
                    helpText="Shown to customers in widgets and cart messages."
                    value={publicTitle}
                    onChange={setPublicTitle}
                    name="publicTitle"
                    autoComplete="off"
                    placeholder="e.g., Free Gift with $50 Purchase"
                  />
                  <TextField
                    label="Priority"
                    helpText="Lower number = higher priority. Evaluated first when multiple offers are active."
                    value={priority}
                    onChange={setPriority}
                    name="priority"
                    type="number"
                    autoComplete="off"
                  />
                </FormLayout>
              </LegacyCard>

              <InlineStack gap="300" align="end">
                <Button onClick={() => navigate("/app/offers")}>Cancel</Button>
                <Button variant="primary" submit>
                  Create & Continue to Conditions →
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <LegacyCard title="Offer Type Guide" sectioned>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm">
                <strong>🎁 Gift:</strong> Auto-add or let customer select a free product when cart meets a threshold.
              </Text>
              <Text as="p" variant="bodySm">
                <strong>📦 Bundle:</strong> Group products together with a discount (classic bundle, mix & match, build-a-box).
              </Text>
              <Text as="p" variant="bodySm">
                <strong>⬆️ Upsell:</strong> Show a recommended product at checkout or on the product page (FBT).
              </Text>
              <Text as="p" variant="bodySm">
                <strong>💰 Discount:</strong> Volume tiers, cart-level discount, or cheapest/most expensive item free.
              </Text>
              <Text as="p" variant="bodySm">
                <strong>🚀 Booster:</strong> Today Offer widget or progress bar — shows active offers site-wide.
              </Text>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
