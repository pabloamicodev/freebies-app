/**
 * Gift Inventory Policy Settings
 * Controls how the promo engine behaves when gift products are out of stock.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, Select, Button,
  Checkbox, Text, BlockStack, Banner, InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

const INVENTORY_SETTINGS = [
  "gift.oos_behavior",
  "gift.auto_swap_enabled",
  "gift.continue_selling_enabled",
  "gift.hide_oos_gifts",
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const settingRows = await db.select()
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId)));

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) {
    try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
  }

  return {
    shopId,
    oosBehavior: (settings["gift.oos_behavior"] as string) ?? "hide",
    autoSwapEnabled: Boolean(settings["gift.auto_swap_enabled"] ?? false),
    continueSelling: Boolean(settings["gift.continue_selling_enabled"] ?? false),
    hideOosGifts: Boolean(settings["gift.hide_oos_gifts"] ?? true),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";
  const formData = await request.formData();

  const updates = {
    "gift.oos_behavior": formData.get("oos_behavior") as string ?? "hide",
    "gift.auto_swap_enabled": formData.get("auto_swap") === "on",
    "gift.continue_selling_enabled": formData.get("continue_selling") === "on",
    "gift.hide_oos_gifts": formData.get("hide_oos") === "on",
  };

  for (const [key, value] of Object.entries(updates)) {
    await db.insert(appSettings)
      .values({ shopId, key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }

  return { success: true };
};

export default function InventorySettingsPage() {
  const { oosBehavior, autoSwapEnabled, continueSelling, hideOosGifts } = useLoaderData<typeof loader>();

  return (
    <Page title="Gift Inventory Policy" subtitle="Control behavior when gift products are out of stock">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Inventory limitation">
            Shopify does not natively reserve cart inventory. A gift shown as available may sell out
            between cart creation and checkout. These settings control the best-effort behavior.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Out of Stock Behavior" sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <Select
                  label="When gift goes out of stock"
                  name="oos_behavior"
                  value={oosBehavior}
                  onChange={() => {}}
                  options={[
                    { label: "Hide the gift (don't show as option)", value: "hide" },
                    { label: "Show as disabled (greyed out, unselectable)", value: "show_disabled" },
                    { label: "Show as available (use continue-selling policy)", value: "show_available" },
                  ]}
                  helpText="Controls what customers see when a gift product has 0 inventory."
                />

                <Checkbox
                  label="Auto-swap to fallback gift"
                  name="auto_swap"
                  checked={autoSwapEnabled}
                  onChange={() => {}}
                  helpText="When the primary gift is OOS, automatically offer the next gift in the reward list by sort order."
                />

                <Checkbox
                  label="Continue selling gifts when inventory_policy = CONTINUE"
                  name="continue_selling"
                  checked={continueSelling}
                  onChange={() => {}}
                  helpText="If the gift product has 'Continue selling when out of stock' enabled in Shopify, allow auto-add even when inventory_quantity is 0."
                />

                <Checkbox
                  label="Hide OOS gifts from slider"
                  name="hide_oos"
                  checked={hideOosGifts}
                  onChange={() => {}}
                  helpText="Remove out-of-stock gifts from the gift slider entirely (not shown as disabled)."
                />

                <Text as="p" fontWeight="semibold">At checkout (always enforced):</Text>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm">✅ Gift is removed if OOS at checkout prepare</Text>
                  <Text as="p" variant="bodySm">✅ Discount Function validates gift availability</Text>
                  <Text as="p" variant="bodySm">✅ Validation Function blocks invalid gift quantity</Text>
                </BlockStack>

                <Button variant="primary" submit>Save Inventory Settings</Button>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
