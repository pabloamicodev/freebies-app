import { useLoaderData, Form, useActionData } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Checkbox, Button, Banner, Text, InlineStack, Box, Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const SETTING_KEYS = [
  "app.enabled",
  "storefront.runtime_enabled",
  "gift.logic_mode",
  "gift.sync_quantity_enabled",
  "gift.hide_clone_products_enabled",
  "cart.auto_cleanup_enabled",
  "cart.debounce_ms",
  "analytics.enabled",
  "headless.enabled",
  "markets.sync_enabled",
  "translations.enabled",
  "debug.enabled",
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select({ id: shops.id, shopDomain: shops.shopDomain, planName: shops.planName })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const settingRows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.shopId, shop.id));

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) {
    try { settings[row.key] = JSON.parse(row.value); }
    catch { settings[row.key] = row.value; }
  }

  // Defaults
  const defaults: Record<SettingKey, unknown> = {
    "app.enabled": true,
    "storefront.runtime_enabled": true,
    "gift.logic_mode": "function",
    "gift.sync_quantity_enabled": true,
    "gift.hide_clone_products_enabled": true,
    "cart.auto_cleanup_enabled": true,
    "cart.debounce_ms": 300,
    "analytics.enabled": true,
    "headless.enabled": false,
    "markets.sync_enabled": true,
    "translations.enabled": false,
    "debug.enabled": false,
  };

  const merged = { ...defaults, ...settings };
  return { shop, settings: merged };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const formData = await request.formData();

  const updates: Record<string, unknown> = {
    "app.enabled": formData.get("app_enabled") === "on",
    "storefront.runtime_enabled": formData.get("runtime_enabled") === "on",
    "gift.logic_mode": formData.get("gift_logic_mode") ?? "function",
    "gift.sync_quantity_enabled": formData.get("gift_sync_quantity") === "on",
    "gift.hide_clone_products_enabled": formData.get("hide_clone_products") === "on",
    "cart.auto_cleanup_enabled": formData.get("auto_cleanup") === "on",
    "cart.debounce_ms": parseInt(formData.get("debounce_ms") as string, 10) || 300,
    "analytics.enabled": formData.get("analytics_enabled") === "on",
    "headless.enabled": formData.get("headless_enabled") === "on",
    "markets.sync_enabled": formData.get("markets_sync") === "on",
    "translations.enabled": formData.get("translations_enabled") === "on",
    "debug.enabled": formData.get("debug_enabled") === "on",
  };

  for (const [key, value] of Object.entries(updates)) {
    await db
      .insert(appSettings)
      .values({ shopId, key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }

  return { success: true };
};

export default function SettingsPage() {
  const { shop, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const s = settings as Record<string, unknown>;

  return (
    <Page title="Settings">
      <Layout>
        {actionData && "success" in actionData && (
          <Layout.Section>
            <Banner tone="success" title="Settings saved" />
          </Layout.Section>
        )}

        <Layout.Section>
          <Form method="POST">
            <BlockStack gap="500">
              <LegacyCard title="App Status" sectioned>
                <BlockStack gap="300">
                  <Checkbox
                    label="App enabled"
                    name="app_enabled"
                    checked={Boolean(s["app.enabled"])}
                    onChange={() => {}}
                    helpText="Master switch — disables all promotions and widget rendering."
                  />
                  <Checkbox
                    label="Storefront runtime enabled"
                    name="runtime_enabled"
                    checked={Boolean(s["storefront.runtime_enabled"])}
                    onChange={() => {}}
                    helpText="Controls whether the app embed JS runtime is active."
                  />
                  <Checkbox
                    label="Debug mode"
                    name="debug_enabled"
                    checked={Boolean(s["debug.enabled"])}
                    onChange={() => {}}
                    helpText="Logs evaluation details to browser console. Disable in production."
                  />
                </BlockStack>
              </LegacyCard>

              <LegacyCard title="Gift Settings" sectioned>
                <FormLayout>
                  <Select
                    label="Gift logic mode"
                    name="gift_logic_mode"
                    options={[
                      { label: "Function mode (recommended) — Discount Function applies discount at checkout", value: "function" },
                      { label: "Clone product mode — Creates a $0 clone product for each gift", value: "clone_product" },
                      { label: "Hybrid mode — Function where possible, clone as fallback", value: "hybrid" },
                    ]}
                    value={String(s["gift.logic_mode"] ?? "function")}
                    onChange={() => {}}
                    helpText="How gift discounts are applied. 'Function' mode is more secure and recommended for Shopify Plus."
                  />
                  <Checkbox
                    label="Sync gift quantity with source product"
                    name="gift_sync_quantity"
                    checked={Boolean(s["gift.sync_quantity_enabled"])}
                    onChange={() => {}}
                    helpText="Only relevant in clone product mode. Keeps clone inventory in sync with source."
                  />
                  <Checkbox
                    label="Hide clone products from search and collections"
                    name="hide_clone_products"
                    checked={Boolean(s["gift.hide_clone_products_enabled"])}
                    onChange={() => {}}
                    helpText="Prevents gift clone products from appearing in search results and product listings."
                  />
                </FormLayout>
              </LegacyCard>

              <LegacyCard title="Cart Settings" sectioned>
                <FormLayout>
                  <Checkbox
                    label="Auto-cleanup invalid gift lines"
                    name="auto_cleanup"
                    checked={Boolean(s["cart.auto_cleanup_enabled"])}
                    onChange={() => {}}
                    helpText="Automatically removes gift lines when the qualifying offer no longer applies."
                  />
                  <TextField
                    label="Cart evaluation debounce (ms)"
                    name="debounce_ms"
                    type="number"
                    value={String(s["cart.debounce_ms"] ?? 300)}
                    onChange={() => {}}
                    autoComplete="off"
                    helpText="How long to wait after a cart change before evaluating offers. 200-500ms recommended."
                  />
                </FormLayout>
              </LegacyCard>

              <LegacyCard title="Features" sectioned>
                <BlockStack gap="300">
                  <Checkbox
                    label="Analytics enabled"
                    name="analytics_enabled"
                    checked={Boolean(s["analytics.enabled"])}
                    onChange={() => {}}
                  />
                  <Checkbox
                    label="Shopify Markets sync enabled"
                    name="markets_sync"
                    checked={Boolean(s["markets.sync_enabled"])}
                    onChange={() => {}}
                    helpText="Syncs market data for multi-currency and market-specific offer conditions."
                  />
                  <Checkbox
                    label="Headless/Hydrogen API enabled"
                    name="headless_enabled"
                    checked={Boolean(s["headless.enabled"])}
                    onChange={() => {}}
                    helpText="Exposes a public evaluation API for headless storefronts."
                  />
                  <Checkbox
                    label="Translation support enabled"
                    name="translations_enabled"
                    checked={Boolean(s["translations.enabled"])}
                    onChange={() => {}}
                  />
                </BlockStack>
              </LegacyCard>

              <InlineStack align="end">
                <Button variant="primary" submit>Save Settings</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <LegacyCard title="Store Info" sectioned>
            <BlockStack gap="200">
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Domain</Text>
                <Text as="p">{shop.shopDomain}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Plan</Text>
                <Text as="p">{shop.planName ?? "Unknown"}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Shopify Plus</Text>
                <Badge tone="success">Active</Badge>
              </Box>
            </BlockStack>
          </LegacyCard>

          <LegacyCard title="Danger Zone" sectioned>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                These actions cannot be undone.
              </Text>
              <Button tone="critical">
                Disable all offers
              </Button>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function BlockStack({ children, gap }: { children: React.ReactNode; gap?: string }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: `${parseInt(gap ?? "0", 10) * 4}px` }}>{children}</div>;
}
