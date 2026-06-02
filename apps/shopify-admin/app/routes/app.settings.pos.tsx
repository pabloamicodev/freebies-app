/**
 * POS Settings — configure which offers apply in Shopify POS.
 * POS cannot render web widgets (gift slider, progress bar, etc.)
 * but Discount Function applies at POS checkout.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, Checkbox, Button, Text,
  BlockStack, Banner, InlineStack, Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const posSettingRows = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "pos.enabled")))
    .limit(1);

  const posEnabled = posSettingRows[0]?.value === "true";
  return { shopId, posEnabled };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const formData = await request.formData();
  const posEnabled = formData.get("pos_enabled") === "on";

  await db.insert(appSettings)
    .values({ shopId, key: "pos.enabled", value: String(posEnabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(posEnabled), updatedAt: new Date() },
    });

  return { success: true };
};

export default function PosSettingsPage() {
  const { posEnabled } = useLoaderData<typeof loader>();

  return (
    <Page title="POS Settings" subtitle="Configure promotions for Shopify Point of Sale">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="POS promotions work differently">
            Web widgets (gift slider, progress bar, today offer) cannot render in POS.
            Discounts are applied via Shopify Discount Function at POS checkout.
            Auto-add gifts may need to be added manually by the POS operator.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="POS Configuration" sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <Checkbox
                  label="Enable promotions in Shopify POS"
                  name="pos_enabled"
                  checked={posEnabled}
                  onChange={() => {}}
                  helpText="When enabled, the Discount Function evaluates and applies eligible promotions at POS checkout."
                />

                <Text as="p" variant="bodySm" tone="subdued">
                  <strong>What works in POS:</strong>
                </Text>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">✅ Discount Function applies gift discounts at checkout</Text>
                  <Text as="p" variant="bodySm">✅ Cart discount (% or fixed amount)</Text>
                  <Text as="p" variant="bodySm">✅ Volume discount tiers</Text>
                  <Text as="p" variant="bodySm">✅ Cheapest item free</Text>
                  <Text as="p" variant="bodySm">❌ Gift slider (web widget)</Text>
                  <Text as="p" variant="bodySm">❌ Progress bar (web widget)</Text>
                  <Text as="p" variant="bodySm">❌ Today Offer floating widget</Text>
                  <Text as="p" variant="bodySm">❌ Auto-add gift (POS operator must add manually)</Text>
                </BlockStack>

                <InlineStack align="start">
                  <Button variant="primary" submit>Save POS Settings</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
