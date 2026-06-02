/**
 * Diagnostics / Debug page
 * Shows sync status, webhook status, metafield config, and error rates.
 * Accessible from admin navigation (Debug / Diagnostics).
 */

import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, Text, Badge, BlockStack, Box,
  InlineStack, Button, DataTable, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, offers, productCache, variantCache, analyticsEvents, cartMutationLogs } from "@promo/db";
import { eq, and, count, gte, sql } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select()
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return { shop: null, diagnostics: null };

  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeOfferCount,
    productCacheCount,
    variantCacheCount,
    recentErrors,
    recentMutations,
    errorMutations,
  ] = await Promise.all([
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shop.id), eq(offers.status, "active"))),
    db.select({ count: count() }).from(productCache).where(eq(productCache.shopId, shop.id)),
    db.select({ count: count() }).from(variantCache).where(eq(variantCache.shopId, shop.id)),
    db.select({ count: count() }).from(analyticsEvents).where(
      and(eq(analyticsEvents.shopId, shop.id), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since1h))
    ),
    db.select({ count: count() }).from(cartMutationLogs).where(
      and(eq(cartMutationLogs.shopId, shop.id), gte(cartMutationLogs.createdAt, since24h))
    ),
    db.select({ count: count() }).from(cartMutationLogs).where(
      and(eq(cartMutationLogs.shopId, shop.id), eq(cartMutationLogs.status, "error"), gte(cartMutationLogs.createdAt, since24h))
    ),
  ]);

  const totalMutations = recentMutations[0]?.count ?? 0;
  const errorCount = errorMutations[0]?.count ?? 0;
  const errorRate = totalMutations > 0 ? ((errorCount / totalMutations) * 100).toFixed(1) : "0";

  return {
    shop: {
      domain: shop.shopDomain,
      isActive: shop.isActive,
      installedAt: shop.installedAt.toISOString(),
      plan: shop.planName,
    },
    diagnostics: {
      activeOffers: activeOfferCount[0]?.count ?? 0,
      cachedProducts: productCacheCount[0]?.count ?? 0,
      cachedVariants: variantCacheCount[0]?.count ?? 0,
      errorsLastHour: recentErrors[0]?.count ?? 0,
      mutationsLast24h: totalMutations,
      errorMutationsLast24h: errorCount,
      errorRate,
    },
  };
};

export default function DiagnosticsPage() {
  const { shop, diagnostics } = useLoaderData<typeof loader>();

  if (!shop || !diagnostics) {
    return (
      <Page title="Diagnostics">
        <Banner tone="critical" title="Shop not found" />
      </Page>
    );
  }

  const isHealthy =
    diagnostics.errorsLastHour === 0 &&
    parseFloat(diagnostics.errorRate) < 5 &&
    diagnostics.cachedProducts > 0;

  return (
    <Page
      title="Diagnostics"
      subtitle="System health and sync status"
      secondaryActions={[
        {
          content: "Trigger full product sync",
          onAction: async () => {
            await fetch("/api/sync/products", { method: "POST" });
          },
        },
      ]}
    >
      <Layout>
        {/* Overall health */}
        <Layout.Section>
          <LegacyCard sectioned>
            <InlineStack gap="300" align="center">
              <Badge tone={isHealthy ? "success" : "critical"}>
                {isHealthy ? "System Healthy" : "Issues Detected"}
              </Badge>
              <Text as="p" tone="subdued">
                {shop.domain} · Installed {new Date(shop.installedAt).toLocaleDateString()}
              </Text>
            </InlineStack>
          </LegacyCard>
        </Layout.Section>

        {/* Metrics */}
        <Layout.Section>
          <DataTable
            columnContentTypes={["text", "numeric"]}
            headings={["Metric", "Value"]}
            rows={[
              ["Active offers", String(diagnostics.activeOffers)],
              ["Cached products", String(diagnostics.cachedProducts)],
              ["Cached variants", String(diagnostics.cachedVariants)],
              ["Cart mutation errors (last hour)", String(diagnostics.errorsLastHour)],
              ["Cart mutations (last 24h)", String(diagnostics.mutationsLast24h)],
              ["Error mutations (last 24h)", String(diagnostics.errorMutationsLast24h)],
              ["Mutation error rate (24h)", `${diagnostics.errorRate}%`],
            ]}
          />
        </Layout.Section>

        {/* Warnings */}
        <Layout.Section>
          {diagnostics.cachedProducts === 0 && (
            <Banner tone="warning" title="No products in cache">
              Product sync has not run or completed. Run a manual sync to populate the cache.
            </Banner>
          )}
          {diagnostics.errorsLastHour > 0 && (
            <Banner tone="critical" title={`${diagnostics.errorsLastHour} cart mutation error(s) in the last hour`}>
              Review cart_mutation_logs table for details.
            </Banner>
          )}
          {parseFloat(diagnostics.errorRate) >= 5 && (
            <Banner tone="critical" title={`High mutation error rate: ${diagnostics.errorRate}%`}>
              Error rate above 5% indicates a systemic issue. Check storefront runtime and cart adapter.
            </Banner>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
