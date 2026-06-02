import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, Text, InlineGrid, Box, Badge,
  Banner, BlockStack, InlineStack, Button, DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, shops } from "@promo/db";
import { eq, and, sql, count } from "drizzle-orm";
import { getDashboardWarnings } from "../lib/dashboard-warnings.server.js";
import { getCampaignBreakdown } from "../lib/analytics.server.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // Wrap all DB calls — if DB isn't ready the dashboard still renders
  try {
    const db = getDb();

    const shopRows = await db.select({ id: shops.id }).from(shops)
      .where(eq(shops.myshopifyDomain, shopDomain)).limit(1);
    const shopId = shopRows[0]?.id ?? "";

    const since30d = new Date(Date.now() - 30 * 86400000);

    const [activeOffersResult, draftOffersResult, scheduledResult] = await Promise.all([
      db.select({ count: count() }).from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active"))).catch(() => [{ count: 0 }]),
      db.select({ count: count() }).from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "draft"))).catch(() => [{ count: 0 }]),
      db.select({ count: count() }).from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "scheduled"))).catch(() => [{ count: 0 }]),
    ]);

    // Warnings and analytics are non-critical — skip if they error
    const warnings = await getDashboardWarnings(shopId, shopDomain).catch(() => []);
    const campaignBreakdown = await getCampaignBreakdown(shopId, since30d).catch(() => []);

    return {
      shopDomain,
      shopId,
      activeOffers: activeOffersResult[0]?.count ?? 0,
      draftOffers: draftOffersResult[0]?.count ?? 0,
      scheduledOffers: scheduledResult[0]?.count ?? 0,
      warnings,
      campaignBreakdown,
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    // Return minimal data so the page still renders
    return {
      shopDomain,
      shopId: "",
      activeOffers: 0,
      draftOffers: 0,
      scheduledOffers: 0,
      warnings: [],
      campaignBreakdown: [],
    };
  }
};

export default function Dashboard() {
  const { shopDomain, activeOffers, draftOffers, scheduledOffers, warnings, campaignBreakdown } =
    useLoaderData<typeof loader>();

  const warningBannerTone = (severity: string) =>
    severity === "error" ? "critical" : severity === "warning" ? "warning" : "info";

  return (
    <Page
      title="Dashboard"
      subtitle={`Promo Engine — ${shopDomain}`}
      primaryAction={{ content: "New Offer", url: "/app/offers/new" }}
      secondaryActions={[{ content: "View Analytics", url: "/app/analytics" }]}
    >
      <Layout>
        {/* ─── Warnings ─────────────────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <Layout.Section>
            <BlockStack gap="300">
              {warnings.map((w) => (
                <Banner
                  key={w.code}
                  tone={warningBannerTone(w.severity)}
                  title={w.title}
                  action={w.action ? { content: w.action.label, url: w.action.url } : undefined}
                >
                  <p>{w.message}</p>
                </Banner>
              ))}
            </BlockStack>
          </Layout.Section>
        )}

        {/* ─── Metrics ──────────────────────────────────────────────────────── */}
        <Layout.Section>
          <InlineGrid columns={4} gap="400">
            <LegacyCard title="Active Offers" sectioned>
              <Text variant="heading2xl" as="p">{activeOffers}</Text>
              <Badge tone="success">Live</Badge>
            </LegacyCard>
            <LegacyCard title="Scheduled" sectioned>
              <Text variant="heading2xl" as="p">{scheduledOffers}</Text>
              <Badge tone="attention">Upcoming</Badge>
            </LegacyCard>
            <LegacyCard title="Draft Offers" sectioned>
              <Text variant="heading2xl" as="p">{draftOffers}</Text>
              <Badge tone="info">Draft</Badge>
            </LegacyCard>
            <LegacyCard title="Sync Status" sectioned>
              <Text variant="heading2xl" as="p">✓</Text>
              <Text as="p" tone="subdued">Products synced</Text>
            </LegacyCard>
          </InlineGrid>
        </Layout.Section>

        {/* ─── Campaign Breakdown ───────────────────────────────────────────── */}
        {campaignBreakdown.length > 0 && (
          <Layout.Section>
            <LegacyCard title="Campaign Type Breakdown (30 days)" sectioned>
              <DataTable
                columnContentTypes={["text", "numeric"]}
                headings={["Offer Type", "Gift Adds"]}
                rows={campaignBreakdown.map((row) => [
                  { gift: "🎁 Gift", bundle: "📦 Bundle", upsell: "⬆️ Upsell", discount: "💰 Discount", booster: "🚀 Booster" }[row.type] ?? row.type,
                  row.count.toLocaleString(),
                ])}
              />
            </LegacyCard>
          </Layout.Section>
        )}

        {/* ─── Quick actions ────────────────────────────────────────────────── */}
        {activeOffers === 0 && (
          <Layout.Section>
            <LegacyCard title="Get started" sectioned>
              <BlockStack gap="300">
                <Text as="p">Create your first offer to start showing gifts and discounts to customers.</Text>
                <InlineStack gap="300">
                  <Button url="/app/offers/new" variant="primary">Create Gift Offer</Button>
                  <Button url="/app/offers/new/bundle" variant="plain">Create Bundle</Button>
                  <Button url="/app/offers/new/discount" variant="plain">Create Discount</Button>
                </InlineStack>
              </BlockStack>
            </LegacyCard>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
