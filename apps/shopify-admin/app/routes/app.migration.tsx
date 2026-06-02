/**
 * Migration from BOGOS page.
 * Guides the merchant through the cutover process:
 * 1. Shadow mode — run promo engine in parallel with BOGOS
 * 2. Parity validation — compare evaluation results
 * 3. Test theme — enable promo engine on a duplicate theme
 * 4. Gradual cutover — disable BOGOS, enable promo engine
 * 5. Post-cutover cleanup — remove BOGOS scripts/classes
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, Text, Badge, BlockStack, Button,
  Banner, ProgressBar, InlineStack, Box, Checkbox,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings, offers } from "@promo/db";
import { eq, and, count } from "drizzle-orm";
import { isShadowModeEnabled, setShadowMode } from "../lib/shadow-mode.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const [shadowMode, activeOffers, draftOffers] = await Promise.all([
    isShadowModeEnabled(shopId),
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.status, "active"))),
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.status, "draft"))),
  ]);

  return {
    shopId,
    shadowMode,
    activeOffers: activeOffers[0]?.count ?? 0,
    draftOffers: draftOffers[0]?.count ?? 0,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "enable_shadow":
      await setShadowMode(shopId, true);
      break;
    case "disable_shadow":
      await setShadowMode(shopId, false);
      break;
  }

  return null;
};

const MIGRATION_STEPS = [
  { id: "audit", label: "Phase 0 — Audit current BOGOS offers", description: "Export and document all BOGOS offers, settings, and Scripts before any changes." },
  { id: "scripts", label: "Scripts sunset check", description: "Verify no legacy Shopify Scripts are active. Scripts stop executing June 30, 2026." },
  { id: "create", label: "Create equivalent offers in Promo Engine", description: "Recreate each BOGOS offer as a draft in the promo engine admin." },
  { id: "shadow", label: "Enable shadow mode", description: "Run promo engine in parallel with BOGOS. Evaluation runs but cart mutations are skipped." },
  { id: "validate", label: "Validate parity", description: "Compare evaluation results between BOGOS and promo engine. Fix any discrepancies." },
  { id: "testtheme", label: "Test on duplicate theme", description: "Enable promo engine blocks on a duplicate theme. Disable BOGOS on that theme. QA all flows." },
  { id: "publish", label: "Publish all offers", description: "Move offers from draft to active. Disable shadow mode." },
  { id: "cutover", label: "Cutover — disable BOGOS", description: "Uninstall BOGOS app. Promo engine is now the sole promotion system." },
  { id: "cleanup", label: "Post-cutover cleanup", description: "Remove BOGOS CSS classes, event listeners, and DOM markers from theme code." },
];

export default function MigrationPage() {
  const { shadowMode, activeOffers, draftOffers } = useLoaderData<typeof loader>();
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

  const progress = Math.round((completedSteps.size / MIGRATION_STEPS.length) * 100);

  return (
    <Page title="Migration from BOGOS" subtitle="Step-by-step cutover guide">
      <Layout>
        {/* Warning */}
        <Layout.Section>
          <Banner tone="warning" title="⚠️ Shopify Scripts sunset: June 30, 2026">
            Before migrating, audit whether BOGOS uses any Shopify Scripts. Scripts stop executing on
            June 30, 2026. All Script-based promotion logic must be replaced by Discount Functions before that date.
          </Banner>
        </Layout.Section>

        {/* Progress */}
        <Layout.Section>
          <LegacyCard title="Migration Progress" sectioned>
            <BlockStack gap="300">
              <InlineStack gap="300" align="space-between">
                <Text as="p">{completedSteps.size} / {MIGRATION_STEPS.length} steps complete</Text>
                <Badge tone={progress === 100 ? "success" : progress > 50 ? "attention" : "info"}>
                  {progress === 100 ? "Migration Complete" : `${progress}%`}
                </Badge>
              </InlineStack>
              <ProgressBar progress={progress} size="small" tone="success" />
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        {/* Status */}
        <Layout.Section>
          <LegacyCard title="Current Status" sectioned>
            <BlockStack gap="200">
              <InlineStack gap="300">
                <Text as="p" fontWeight="semibold">Shadow mode:</Text>
                <Badge tone={shadowMode ? "attention" : "info"}>
                  {shadowMode ? "Enabled — evaluating but not mutating" : "Disabled"}
                </Badge>
              </InlineStack>
              <InlineStack gap="300">
                <Text as="p" fontWeight="semibold">Active offers:</Text>
                <Text as="p">{activeOffers}</Text>
              </InlineStack>
              <InlineStack gap="300">
                <Text as="p" fontWeight="semibold">Draft offers:</Text>
                <Text as="p">{draftOffers}</Text>
              </InlineStack>
            </BlockStack>

            <Box paddingBlockStart="400">
              <Form method="POST">
                {shadowMode ? (
                  <>
                    <Text as="p" tone="subdued">Shadow mode is active. Promo engine evaluates offers but does not modify the cart.</Text>
                    <Box paddingBlockStart="300">
                      <Button variant="primary" tone="critical" submit name="intent" value="disable_shadow">
                        Disable Shadow Mode (go live)
                      </Button>
                    </Box>
                  </>
                ) : (
                  <>
                    <Text as="p" tone="subdued">Enable shadow mode to run promo engine in parallel with BOGOS without affecting the cart.</Text>
                    <Box paddingBlockStart="300">
                      <Button variant="primary" submit name="intent" value="enable_shadow">
                        Enable Shadow Mode
                      </Button>
                    </Box>
                  </>
                )}
              </Form>
            </Box>
          </LegacyCard>
        </Layout.Section>

        {/* Migration checklist */}
        <Layout.Section>
          <LegacyCard title="Migration Checklist" sectioned>
            <BlockStack gap="300">
              {MIGRATION_STEPS.map((step) => (
                <Box key={step.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                  <Checkbox
                    label={step.label}
                    checked={completedSteps.has(step.id)}
                    onChange={(checked) => {
                      const next = new Set(completedSteps);
                      checked ? next.add(step.id) : next.delete(step.id);
                      setCompletedSteps(next);
                    }}
                    helpText={step.description}
                  />
                </Box>
              ))}
            </BlockStack>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
