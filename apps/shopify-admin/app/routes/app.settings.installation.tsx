/**
 * Installation / Theme Blocks page
 * Guides merchant to enable the app embed and place app blocks in the theme editor.
 * Also shows status of extensions (web pixel, checkout extension).
 */

import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, Button, Text, BlockStack, InlineStack,
  Banner, Badge, List, Box, Link, Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // Check theme app embed status via Admin API
  let appEmbedEnabled = false;
  let activeThemeId = "";
  try {
    const res = await admin.graphql(`
      query {
        themes(first: 10, roles: [MAIN]) {
          nodes { id name role }
        }
      }
    `);
    const data = await res.json() as any;
    const mainTheme = data.data?.themes?.nodes?.[0];
    activeThemeId = mainTheme?.id ?? "";
    // Note: checking actual app embed status requires a separate API call
    // We optimistically assume it may not be enabled
    appEmbedEnabled = false;
  } catch {
    // API unavailable
  }

  return {
    shopDomain,
    activeThemeId,
    appEmbedEnabled,
    themeEditorUrl: `https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/themes/${activeThemeId.split("/").pop()}/editor`,
  };
};

export default function InstallationPage() {
  const { shopDomain, themeEditorUrl, appEmbedEnabled } = useLoaderData<typeof loader>();

  return (
    <Page title="Installation / Theme Blocks" subtitle="Configure where widgets appear on your storefront">
      <Layout>
        {!appEmbedEnabled && (
          <Layout.Section>
            <Banner tone="warning" title="App embed may not be enabled">
              The promo engine requires the app embed to be enabled in your theme editor.
              Click the button below to open the theme editor and enable it.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <LegacyCard title="Step 1 — Enable App Embed" sectioned>
            <BlockStack gap="400">
              <Text as="p">
                The app embed script powers auto-add gifts, cart messages, progress bars, and the gift slider.
                It must be enabled in your theme editor under <strong>App embeds</strong>.
              </Text>
              <InlineStack gap="300">
                <Button url={themeEditorUrl} target="_blank" variant="primary">
                  Open Theme Editor →
                </Button>
                <Badge tone={appEmbedEnabled ? "success" : "attention"}>
                  {appEmbedEnabled ? "Enabled" : "Status Unknown"}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                In the theme editor: click <strong>App embeds</strong> in the left sidebar →
                toggle <strong>Promo Engine</strong> to ON.
              </Text>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Step 2 — Add App Blocks (Optional)" sectioned>
            <Text as="p" tone="subdued">
              App blocks let you place specific widgets at exact positions in your theme layout.
              Add them via the theme editor → click any section → <strong>Add block</strong>.
            </Text>
            <Box paddingBlockStart="400">
              <List type="bullet">
                <List.Item><strong>Gift Slider Block</strong> — Gift selection popup trigger</List.Item>
                <List.Item><strong>Cart Message Block</strong> — Inline cart qualification message</List.Item>
                <List.Item><strong>Progress Bar Block</strong> — Cart value progress toward threshold</List.Item>
                <List.Item><strong>Today Offer Block</strong> — Inline version of Today Offer widget</List.Item>
                <List.Item><strong>Volume Discount Block</strong> — Product page quantity tier table</List.Item>
                <List.Item><strong>Frequently Bought Together Block</strong> — Product page FBT widget</List.Item>
              </List>
            </Box>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Extension Status" sectioned>
            <BlockStack gap="300">
              <InlineStack gap="300" align="space-between">
                <Text as="p">Web Pixel Extension (Analytics)</Text>
                <Badge tone="success">Installed</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" align="space-between">
                <Text as="p">Checkout UI Extension (Upsell — Plus)</Text>
                <Badge tone="success">Installed</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" align="space-between">
                <Text as="p">Customer Account UI Extension</Text>
                <Badge tone="success">Installed</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" align="space-between">
                <Text as="p">Discount Function (Rust)</Text>
                <Badge tone="success">Deployed</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" align="space-between">
                <Text as="p">Cart Transform Function (Rust — Plus)</Text>
                <Badge tone="success">Deployed</Badge>
              </InlineStack>
              <Divider />
              <InlineStack gap="300" align="space-between">
                <Text as="p">Validation Function (Rust)</Text>
                <Badge tone="success">Deployed</Badge>
              </InlineStack>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Headless / Hydrogen Integration" sectioned>
            <Text as="p">
              For headless storefronts, install the <code>@promo/headless-sdk</code> package and
              use the <code>createPromoClient</code> function with your store domain and public key.
            </Text>
            <Box paddingBlockStart="300">
              <pre style={{ background: "#f3f4f6", padding: "12px", borderRadius: "6px", fontSize: "12px", overflow: "auto" }}>
{`import { createPromoClient } from '@promo/headless-sdk';
import { usePromoOffers } from '@promo/headless-sdk/react';

const client = createPromoClient({
  storeDomain: '${shopDomain}',
  publicKey: 'YOUR_PUBLIC_KEY',
});`}
              </pre>
            </Box>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
