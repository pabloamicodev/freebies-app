import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, Text, InlineGrid, Box,
  DataTable, Button, InlineStack, Select, Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { analyticsEvents, offers, shops } from "@promo/db";
import { eq, and, gte, count, sql, desc } from "drizzle-orm";
import { ConversionFunnelChart, CampaignBreakdownChart, MetricLineChart, TopOffersChart } from "../components/AnalyticsCharts.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);

  const shopId = shopRows[0]?.id;
  if (!shopId) return { metrics: null, topOffers: [], funnelData: [], days };

  // ── Key metrics ──────────────────────────────────────────────────────────
  const [
    impressionsResult,
    giftAddsResult,
    giftRemovesResult,
    mutationErrorsResult,
    inventoryFailuresResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.eventName, "widget_viewed"), gte(analyticsEvents.occurredAt, since))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.eventName, "promo_engine:gift_auto_added"), gte(analyticsEvents.occurredAt, since))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.eventName, "promo_engine:gift_removed"), gte(analyticsEvents.occurredAt, since))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.eventName, "promo_engine:inventory_failure"), gte(analyticsEvents.occurredAt, since))),
  ]);

  const totalImpressions = impressionsResult[0]?.count ?? 0;
  const totalGiftAdds = giftAddsResult[0]?.count ?? 0;
  const totalGiftRemoves = giftRemovesResult[0]?.count ?? 0;
  const totalErrors = mutationErrorsResult[0]?.count ?? 0;
  const totalInventoryFailures = inventoryFailuresResult[0]?.count ?? 0;

  // ── Top offers by gift adds ───────────────────────────────────────────────
  const topOffersQuery = await db
    .select({
      offerId: analyticsEvents.offerId,
      adds: count(),
    })
    .from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.eventName, "promo_engine:gift_auto_added"),
      gte(analyticsEvents.occurredAt, since),
    ))
    .groupBy(analyticsEvents.offerId)
    .orderBy(sql`count(*) DESC`)
    .limit(10);

  const offerIds = topOffersQuery.map((r) => r.offerId).filter(Boolean) as string[];

  const offerNames: Record<string, string> = {};
  if (offerIds.length > 0) {
    const offerRows = await db
      .select({ id: offers.id, internalName: offers.internalName })
      .from(offers)
      .where(eq(offers.shopId, shopId));
    offerRows.forEach((o) => { offerNames[o.id] = o.internalName; });
  }

  const topOffers = topOffersQuery.map((r) => ({
    offerId: r.offerId ?? "",
    name: offerNames[r.offerId ?? ""] ?? r.offerId ?? "—",
    adds: r.adds,
  }));

  // ── Funnel data ───────────────────────────────────────────────────────────
  const funnelSteps = [
    { event: "widget_viewed", label: "Widget Impression" },
    { event: "promo_engine:offer_qualified", label: "Offer Qualified" },
    { event: "promo_engine:gift_auto_added", label: "Gift Added" },
    { event: "checkout_started", label: "Checkout Started" },
    { event: "order_placed", label: "Order Placed" },
  ];

  const funnelData = await Promise.all(
    funnelSteps.map(async (step) => {
      const res = await db
        .select({ count: count() })
        .from(analyticsEvents)
        .where(and(
          eq(analyticsEvents.shopId, shopId),
          eq(analyticsEvents.eventName, step.event),
          gte(analyticsEvents.occurredAt, since),
        ));
      return { label: step.label, count: res[0]?.count ?? 0 };
    }),
  );

  return {
    metrics: {
      totalImpressions,
      totalGiftAdds,
      totalGiftRemoves,
      giftAddRate: totalImpressions > 0 ? ((totalGiftAdds / totalImpressions) * 100).toFixed(1) : "0",
      totalErrors,
      totalInventoryFailures,
      errorRate: totalGiftAdds > 0 ? ((totalErrors / totalGiftAdds) * 100).toFixed(1) : "0",
    },
    topOffers,
    funnelData,
    days,
  };
};

export default function AnalyticsPage() {
  const { metrics, topOffers, funnelData, days } = useLoaderData<typeof loader>();

  if (!metrics) {
    return (
      <Page title="Analytics">
        <LegacyCard sectioned>
          <Text as="p" tone="subdued">No analytics data yet. Analytics are collected once offers are active.</Text>
        </LegacyCard>
      </Page>
    );
  }

  const metricCards = [
    { title: "Widget Impressions", value: metrics.totalImpressions.toLocaleString() },
    { title: "Gift Adds", value: metrics.totalGiftAdds.toLocaleString() },
    { title: "Add Rate", value: `${metrics.giftAddRate}%` },
    { title: "Gift Removes", value: metrics.totalGiftRemoves.toLocaleString() },
    { title: "Cart Errors", value: metrics.totalErrors.toLocaleString() },
    { title: "Inventory Failures", value: metrics.totalInventoryFailures.toLocaleString() },
  ];

  return (
    <Page
      title="Analytics"
      secondaryActions={[
        { content: "Export CSV", onAction: () => {} },
      ]}
    >
      <Layout>
        {/* Date range selector */}
        <Layout.Section>
          <InlineStack gap="300" align="end">
            <form method="GET">
              <InlineStack gap="200">
                <Select
                  label="Date range"
                  name="days"
                  options={[
                    { label: "Last 7 days", value: "7" },
                    { label: "Last 30 days", value: "30" },
                    { label: "Last 90 days", value: "90" },
                  ]}
                  value={String(days)}
                  onChange={() => {}}
                />
                <Button submit>Apply</Button>
              </InlineStack>
            </form>
          </InlineStack>
        </Layout.Section>

        {/* Metric cards */}
        <Layout.Section>
          <InlineGrid columns={3} gap="400">
            {metricCards.map((card) => (
              <LegacyCard key={card.title} sectioned>
                <Text variant="heading2xl" as="p">{card.value}</Text>
                <Text as="p" tone="subdued">{card.title}</Text>
              </LegacyCard>
            ))}
          </InlineGrid>
        </Layout.Section>

        {/* Conversion Funnel */}
        <Layout.Section>
          <LegacyCard title="Conversion Funnel" sectioned>
            <Box paddingBlockStart="400">
              {funnelData.map((step, i) => {
                const prevCount = funnelData[i - 1]?.count ?? step.count;
                const pct = prevCount > 0 ? Math.round((step.count / prevCount) * 100) : 100;
                return (
                  <Box key={step.label} paddingBlockEnd="300">
                    <InlineStack gap="400" align="space-between">
                      <Text as="span">{step.label}</Text>
                      <InlineStack gap="300">
                        <Text as="span" fontWeight="semibold">{step.count.toLocaleString()}</Text>
                        {i > 0 && (
                          <Text as="span" tone={pct > 50 ? "success" : pct > 20 ? "caution" : "critical"}>
                            {pct}%
                          </Text>
                        )}
                      </InlineStack>
                    </InlineStack>
                    <div style={{
                      height: "6px",
                      background: "#e5e7eb",
                      borderRadius: "999px",
                      marginTop: "6px",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        height: "100%",
                        width: `${i === 0 ? 100 : pct}%`,
                        background: "#111",
                        borderRadius: "999px",
                        transition: "width .4s",
                      }} />
                    </div>
                  </Box>
                );
              })}
            </Box>
          </LegacyCard>
        </Layout.Section>

        {/* Top Offers */}
        <Layout.Section>
          <LegacyCard title="Top Offers by Gift Adds">
            <DataTable
              columnContentTypes={["text", "text", "numeric"]}
              headings={["Offer ID", "Name", "Gift Adds"]}
              rows={topOffers.map((o) => [
                o.offerId.slice(0, 8) + "…",
                o.name,
                o.adds.toLocaleString(),
              ])}
              defaultSortDirection="descending"
              sortable={[false, false, true]}
            />
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
