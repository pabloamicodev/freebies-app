/**
 * Per-offer analytics drill-down page.
 * Shows full funnel, top gift products, error rate, and A/B comparison.
 */

import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, DataTable, Text, InlineStack,
  Badge, Box, BlockStack, Button,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { analyticsEvents, offers, cartMutationLogs } from "@promo/db";
import { eq, and, gte, count, sql } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const offerRows = await db.select().from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const FUNNEL_EVENTS = [
    { event: "promo_engine:widget_viewed", label: "Widget Viewed" },
    { event: "promo_engine:offer_qualified", label: "Offer Qualified" },
    { event: "promo_engine:gift_auto_added", label: "Gift Added" },
    { event: "checkout_started", label: "Checkout Started" },
    { event: "order_placed_attributed", label: "Order Placed" },
  ];

  const funnelData = await Promise.all(
    FUNNEL_EVENTS.map(async (step) => {
      const res = await db.select({ count: count() }).from(analyticsEvents)
        .where(and(
          eq(analyticsEvents.shopId, shopId),
          eq(analyticsEvents.eventName, step.event),
          eq(analyticsEvents.offerId, offerId),
          gte(analyticsEvents.occurredAt, since30d),
        ));
      return { label: step.label, count: res[0]?.count ?? 0 };
    }),
  );

  // Error rate
  const [errorCount, mutationCount] = await Promise.all([
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since30d))),
    db.select({ count: count() }).from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId), gte(analyticsEvents.occurredAt, since30d))),
  ]);

  const totalEvents = mutationCount[0]?.count ?? 0;
  const errorEvents = errorCount[0]?.count ?? 0;
  const errorRate = totalEvents > 0 ? ((errorEvents / totalEvents) * 100).toFixed(1) : "0";

  return {
    offer: { id: offer.id, internalName: offer.internalName, type: offer.type, status: offer.status },
    funnelData,
    errorRate,
    totalEvents,
  };
};

export default function OfferAnalyticsPage() {
  const { offer, funnelData, errorRate, totalEvents } = useLoaderData<typeof loader>();

  return (
    <Page
      title={`Analytics — ${offer.internalName}`}
      backAction={{ content: "All Analytics", url: "/app/analytics" }}
      secondaryActions={[{ content: "Export CSV", onAction: () => window.location.href = `/api/offers/${offer.id}/export` }]}
    >
      <Layout>
        <Layout.Section>
          <InlineStack gap="300">
            <Badge tone="info">{offer.type}</Badge>
            <Badge tone={offer.status === "active" ? "success" : "attention"}>{offer.status}</Badge>
          </InlineStack>
        </Layout.Section>

        {/* Conversion Funnel */}
        <Layout.Section>
          <LegacyCard title="Conversion Funnel (Last 30 Days)" sectioned>
            {funnelData.map((step, i) => {
              const prev = funnelData[i - 1]?.count ?? step.count;
              const pct = prev > 0 ? Math.round((step.count / prev) * 100) : 100;
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
                  <div style={{ height: 6, background: "#e5e7eb", borderRadius: 999, marginTop: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${i === 0 ? 100 : pct}%`, background: "#111", borderRadius: 999 }} />
                  </div>
                </Box>
              );
            })}
          </LegacyCard>
        </Layout.Section>

        {/* Health metrics */}
        <Layout.Section>
          <LegacyCard title="Health" sectioned>
            <DataTable
              columnContentTypes={["text", "numeric"]}
              headings={["Metric", "Value"]}
              rows={[
                ["Total events (30d)", totalEvents.toLocaleString()],
                ["Cart mutation error rate", `${errorRate}%`],
                ["Status", offer.status],
              ]}
            />
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
