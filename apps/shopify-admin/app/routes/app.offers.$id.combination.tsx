/**
 * Combination Policy editor — Step 6 of the offer builder wizard.
 * Controls stacking, combination with other discounts, max applications.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Checkbox,
  Button, BlockStack, Text, InlineStack, Banner,
} from "@shopify/polaris";
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
  if (!offer) return <Page title="Not Found" />;

  return (
    <Page
      title="Combination Policy"
      subtitle={offer.internalName}
      backAction={{ content: "← Widget Settings", url: `/app/offers/${offer.id}/widget` }}
      primaryAction={{ content: "→ Review & Publish", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        <Layout.Section>
          <LegacyCard title="Combination with other discounts" sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <Checkbox
                  label="Combines with order discounts"
                  name="order_discounts"
                  checked={policy?.combinesWithOrderDiscounts ?? true}
                  onChange={() => {}}
                  helpText="Allow this offer to stack with other order-level discounts (e.g., coupon codes)."
                />
                <Checkbox
                  label="Combines with product discounts"
                  name="product_discounts"
                  checked={policy?.combinesWithProductDiscounts ?? true}
                  onChange={() => {}}
                  helpText="Allow this offer to stack with product-level discounts."
                />
                <Checkbox
                  label="Combines with shipping discounts"
                  name="shipping_discounts"
                  checked={policy?.combinesWithShippingDiscounts ?? true}
                  onChange={() => {}}
                  helpText="Allow this offer to stack with free shipping or shipping discount codes."
                />
                <Checkbox
                  label="Combines with other app offers"
                  name="other_app_offers"
                  checked={policy?.combinesWithOtherAppOffers ?? true}
                  onChange={() => {}}
                  helpText="Allow this offer to apply alongside other active promo engine offers."
                />

                <Text as="p" fontWeight="semibold">Priority behavior</Text>

                <Checkbox
                  label="Stop lower-priority offers"
                  name="stop_lower_priority"
                  checked={policy?.stopLowerPriority ?? false}
                  onChange={() => {}}
                  helpText="When this offer qualifies, offers with higher priority numbers will not be evaluated. Useful for exclusive promotions."
                />
                <Checkbox
                  label="Gift value counts toward other offer thresholds"
                  name="gift_value_counts"
                  checked={policy?.giftValueCountsForOtherOffers ?? false}
                  onChange={() => {}}
                  helpText="By default, gift line values don't count toward the cart value of other offers. Enable this to include them."
                />

                <FormLayout.Group>
                  <TextField
                    label="Max applications per cart"
                    name="max_per_cart"
                    type="number"
                    defaultValue={policy?.maxApplicationsPerCart?.toString() ?? ""}
                    autoComplete="off"
                    helpText="Limit how many times this offer can apply in a single cart (e.g., 1 for one-time only)."
                    placeholder="Unlimited"
                  />
                  <TextField
                    label="Max applications per customer (lifetime)"
                    name="max_per_customer"
                    type="number"
                    defaultValue={policy?.maxApplicationsPerCustomer?.toString() ?? ""}
                    autoComplete="off"
                    helpText="Limit how many times a customer can use this offer across all their orders."
                    placeholder="Unlimited"
                  />
                </FormLayout.Group>

                <Button variant="primary" submit>Save Combination Policy</Button>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
