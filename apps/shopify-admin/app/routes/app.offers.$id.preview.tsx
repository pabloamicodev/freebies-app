/**
 * Offer Preview / Debug panel.
 * Allows the merchant to simulate a cart + customer scenario
 * and see exactly why an offer qualifies or doesn't.
 */

import { useLoaderData, Form, useActionData } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select, Button,
  Banner, Badge, BlockStack, Text, Box, InlineStack, Divider,
  Collapsible, Link,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { evaluate } from "@promo/rule-engine";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import type { EvaluationInput, EvaluationResult } from "@promo/shared-types";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  return { offer: { id: offer.id, internalName: offer.internalName, type: offer.type } };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const cartValueUsd = parseFloat(formData.get("cartValue") as string) || 0;
  const cartQty = parseInt(formData.get("cartQty") as string, 10) || 1;
  const customerTags = (formData.get("customerTags") as string).split(",").map((t) => t.trim()).filter(Boolean);
  const salesChannel = (formData.get("salesChannel") as string) || "online_store";
  const marketId = (formData.get("marketId") as string) || null;
  const currencyCode = (formData.get("currencyCode") as string) || "USD";

  // Load offer definitions
  const [conditionRows, rewardRows, policyRows] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
  ]);

  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) return { error: "Offer not found" };

  const offerDef = {
    id: offer.id,
    version: 1,
    type: offer.type,
    priority: offer.priority,
    stopLowerPriority: policyRows[0]?.stopLowerPriority ?? false,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    conditions: conditionRows.map((c) => ({
      id: c.id,
      scope: c.scope,
      conditionType: c.conditionType,
      operator: c.operator,
      value: c.value,
      isEnabled: c.isEnabled,
      sortOrder: c.sortOrder,
    })),
    rewards: rewardRows.map((r) => ({
      id: r.id,
      rewardType: r.rewardType,
      discountType: r.discountType,
      value: r.value,
      target: r.target,
      quantity: r.quantity,
      isAutoAdd: r.isAutoAdd,
      isCustomerSelectable: r.isCustomerSelectable,
      trackMode: r.trackMode as "product" | "variant",
      sortOrder: r.sortOrder,
      label: r.label,
    })),
    combinationPolicy: {
      combinesWithOrderDiscounts: policyRows[0]?.combinesWithOrderDiscounts ?? true,
      combinesWithProductDiscounts: policyRows[0]?.combinesWithProductDiscounts ?? true,
      combinesWithShippingDiscounts: policyRows[0]?.combinesWithShippingDiscounts ?? true,
      stopLowerPriority: policyRows[0]?.stopLowerPriority ?? false,
      maxApplicationsPerCart: policyRows[0]?.maxApplicationsPerCart ?? null,
      maxApplicationsPerCustomer: policyRows[0]?.maxApplicationsPerCustomer ?? null,
    },
    giftValueCountsForOtherOffers: policyRows[0]?.giftValueCountsForOtherOffers ?? false,
  };

  const simulatedInput: EvaluationInput = {
    shopDomain: session.shop,
    cart: {
      token: "preview-session",
      id: null,
      lines: [
        {
          key: "preview-line-1",
          variantId: "gid://shopify/ProductVariant/preview",
          productId: "gid://shopify/Product/preview",
          quantity: cartQty,
          priceCents: Math.round(cartValueUsd * 100),
          compareAtPriceCents: null,
          properties: {},
          requiresSellingPlan: false,
          sellingPlanId: null,
          productHandle: "preview-product",
          productTitle: "Simulated Product",
          variantTitle: null,
          vendor: "Preview Vendor",
          productType: "apparel",
          tags: [],
          collections: [],
          availableForSale: true,
          inventoryPolicy: "DENY",
          inventoryQuantity: 100,
        },
      ],
      subtotalCents: Math.round(cartValueUsd * 100),
      discountCodes: [],
      currencyCode,
      totalQuantity: cartQty,
    },
    customer: customerTags.length > 0
      ? {
          id: "preview-customer",
          email: "preview@example.com",
          tags: customerTags,
          totalSpentCents: 0,
          totalOrders: 1,
          lastOrderSpentCents: null,
          countryCode: null,
          isFirstTimeCustomer: false,
        }
      : null,
    market: marketId
      ? {
          id: marketId,
          handle: "preview-market",
          currencyCode,
          countryCode: null,
          primaryLocale: "en",
        }
      : null,
    locale: "en",
    salesChannel: salesChannel as any,
    requestedUrl: null,
    sessionId: "preview-session",
  };

  const result = await evaluate(simulatedInput, {
    offers: [offerDef],
    oneUseStates: [],
    now: new Date(),
  });

  return { result, simulatedInput };
};

export default function OfferPreviewPage() {
  const { offer } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [showRawInput, setShowRawInput] = useState(false);

  const result = actionData && "result" in actionData ? actionData.result : null;
  const qualified = result?.qualifiedOffers.find((o) => o.offerId === offer.id);
  const disqualified = result?.disqualifiedOffers.find((o) => o.offerId === offer.id);

  return (
    <Page
      title="Offer Preview & Debug"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        <Layout.Section variant="oneHalf">
          <LegacyCard title="Simulate Cart" sectioned>
            <Form method="POST">
              <FormLayout>
                <TextField
                  label="Cart subtotal (USD)"
                  name="cartValue"
                  type="number"
                  defaultValue="50"
                  autoComplete="off"
                  helpText="Total value of non-gift lines in cart"
                />
                <TextField
                  label="Cart item quantity"
                  name="cartQty"
                  type="number"
                  defaultValue="1"
                  autoComplete="off"
                />
                <TextField
                  label="Customer tags"
                  name="customerTags"
                  defaultValue=""
                  autoComplete="off"
                  helpText="Comma-separated tags. Leave empty for guest."
                  placeholder="vip, wholesale"
                />
                <Select
                  label="Sales channel"
                  name="salesChannel"
                  options={[
                    { label: "Online Store", value: "online_store" },
                    { label: "POS", value: "pos" },
                    { label: "Mobile App", value: "mobile_app" },
                    { label: "Headless", value: "headless" },
                  ]}
                />
                <TextField
                  label="Currency code"
                  name="currencyCode"
                  defaultValue="USD"
                  autoComplete="off"
                />
                <TextField
                  label="Market ID (optional)"
                  name="marketId"
                  defaultValue=""
                  autoComplete="off"
                  placeholder="gid://shopify/Market/1"
                />
                <Button variant="primary" submit>
                  Run Evaluation
                </Button>
              </FormLayout>
            </Form>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          {result && (
            <BlockStack gap="400">
              {/* Qualification result */}
              <LegacyCard sectioned>
                {qualified ? (
                  <Banner tone="success" title="✅ Offer QUALIFIES">
                    <p>All conditions passed. {qualified.cartActions.length} cart action(s) generated.</p>
                  </Banner>
                ) : (
                  <Banner tone="critical" title="❌ Offer does NOT qualify">
                    <p>One or more conditions failed. See reasons below.</p>
                  </Banner>
                )}
              </LegacyCard>

              {/* Condition reasons */}
              <LegacyCard title="Condition Results" sectioned>
                <BlockStack gap="300">
                  {(qualified ?? disqualified)?.reasons.map((reason, i) => (
                    <InlineStack key={i} gap="300" align="start">
                      <Text as="span">{reason.passed ? "✅" : "❌"}</Text>
                      <Box>
                        <Text as="p" fontWeight="semibold">{reason.conditionType}</Text>
                        <Text as="p" tone="subdued">{reason.message}</Text>
                        {reason.actual !== undefined && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            Actual: {JSON.stringify(reason.actual)} | Required: {JSON.stringify(reason.required)}
                          </Text>
                        )}
                      </Box>
                    </InlineStack>
                  ))}
                </BlockStack>
              </LegacyCard>

              {/* Cart actions */}
              {qualified && qualified.cartActions.length > 0 && (
                <LegacyCard title="Cart Actions Generated" sectioned>
                  <BlockStack gap="200">
                    {qualified.cartActions.map((action, i) => (
                      <Box key={i} padding="300" borderWidth="025" borderColor="border" borderRadius="100">
                        <Text as="p" fontWeight="semibold">{action.action}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {JSON.stringify(action, null, 2)}
                        </Text>
                      </Box>
                    ))}
                  </BlockStack>
                </LegacyCard>
              )}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
