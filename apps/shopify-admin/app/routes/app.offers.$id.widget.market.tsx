/**
 * Per-market widget configuration page — linked from the widget settings tab.
 * GET  /app/offers/:id/widget/market
 * POST /app/offers/:id/widget/market  → save market overrides
 */

import { useLoaderData, useActionData, Form } from "react-router";
import { Page, Layout, LegacyCard, Banner, Text, BlockStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, widgets, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { getMarketsForShop } from "../lib/markets.server.js";
import { MarketWidgetConfig } from "../components/MarketWidgetConfig.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [shopRow] = await db.select({ id: shops.id })
    .from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";

  const [offerWidgets, markets, marketOverrideRow] = await Promise.all([
    db.select().from(widgets).where(and(eq(widgets.offerId, offerId), eq(widgets.shopId, shopId))).limit(1),
    getMarketsForShop(shopId),
    db.select({ value: appSettings.value })
      .from(appSettings)
      .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, `widget.market_overrides.${offerId}`)))
      .limit(1),
  ]);

  const widget = offerWidgets[0];
  const marketOverrides = marketOverrideRow[0]?.value
    ? JSON.parse(marketOverrideRow[0].value)
    : [];

  // Get base threshold from widget config
  const widgetConfig = (widget?.config ?? {}) as Record<string, unknown>;
  const baseThresholdCents = widgetConfig["thresholdCents"] as number | undefined;

  return {
    offerId,
    shopId,
    widgetId: widget?.id ?? "",
    markets,
    marketOverrides,
    baseThresholdCents,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  const [shopRow] = await db.select({ id: shops.id })
    .from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";

  const overridesJson = formData.get("overrides") as string;
  let overrides = [];
  try { overrides = JSON.parse(overridesJson); } catch {}

  await db.insert(appSettings)
    .values({ shopId, key: `widget.market_overrides.${offerId}`, value: JSON.stringify(overrides) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(overrides), updatedAt: new Date() },
    });

  return { success: true, savedCount: overrides.length };
};

export default function WidgetMarketPage() {
  const { offerId, markets, marketOverrides, baseThresholdCents, widgetId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  async function handleSave(overrides: any[]) {
    const form = new FormData();
    form.append("overrides", JSON.stringify(overrides));
    await fetch("", { method: "POST", body: form });
  }

  return (
    <Page
      title="Per-Market Widget Config"
      backAction={{ content: "← Widget Settings", url: `/app/offers/${offerId}/widget` }}
    >
      <Layout>
        {actionData?.success && (
          <Layout.Section>
            <Banner tone="success" title={`${actionData.savedCount} market override(s) saved`} />
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            <LegacyCard sectioned>
              <Text as="p" tone="subdued">
                Configure per-market behavior: custom thresholds in local currency,
                translated widget titles, and market-specific enable/disable.
                Eligibility rules are always evaluated server-side — only display
                is customized here.
              </Text>
            </LegacyCard>

            <MarketWidgetConfig
              widgetId={widgetId}
              baseThresholdCents={baseThresholdCents}
              defaultOverrides={marketOverrides}
              onSave={handleSave}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
