/**
 * Debug/Diagnostics panel for an individual offer.
 * Shows: compiled function config, metafield status, recent evaluation errors.
 */

import { useLoaderData } from "react-router";
import {
  Page, Layout, LegacyCard, Text, Badge, BlockStack, Box, Button,
  InlineStack, Banner, DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, cartMutationLogs, analyticsEvents } from "@promo/db";
import { eq, and, desc, count } from "drizzle-orm";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

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

  const [offerRows, recentErrors, mutationErrors] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"),
      ))
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(10),
    db.select().from(cartMutationLogs)
      .where(and(
        eq(cartMutationLogs.shopId, shopId),
        eq(cartMutationLogs.offerId, offerId),
        eq(cartMutationLogs.status, "error"),
      ))
      .orderBy(desc(cartMutationLogs.createdAt))
      .limit(10),
  ]);

  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const compiledConfig = offer.compiledConfig;
  const hasCompiledConfig = !!compiledConfig;
  const configSize = compiledConfig ? JSON.stringify(compiledConfig).length : 0;

  return {
    offer: {
      id: offer.id,
      internalName: offer.internalName,
      status: offer.status,
      functionMetafieldGid: offer.functionMetafieldGid,
      hasCompiledConfig,
      configSize,
      compiledConfigJson: hasCompiledConfig ? JSON.stringify(compiledConfig, null, 2) : null,
    },
    recentErrors: recentErrors.map((e) => ({
      occurred: e.occurredAt.toISOString(),
      sessionId: e.sessionId ?? "—",
      properties: JSON.stringify(e.properties).slice(0, 100),
    })),
    mutationErrors: mutationErrors.map((e) => ({
      created: e.createdAt.toISOString(),
      type: e.mutationType,
      error: e.errorMessage ?? "—",
      source: e.source,
    })),
  };
};

export default function OfferDebugPage() {
  const { offer, recentErrors, mutationErrors } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Debug & Diagnostics"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        {/* Function config status */}
        <Layout.Section>
          <LegacyCard title="Shopify Function Config" sectioned>
            <BlockStack gap="300">
              <InlineStack gap="300">
                <Text as="p">Compiled config:</Text>
                <Badge tone={offer.hasCompiledConfig ? "success" : "critical"}>
                  {offer.hasCompiledConfig ? "Present" : "Missing"}
                </Badge>
              </InlineStack>
              {offer.hasCompiledConfig && (
                <InlineStack gap="300">
                  <Text as="p">Config size:</Text>
                  <Text as="p">{offer.configSize} bytes</Text>
                  <Badge tone={offer.configSize > 9500 ? "critical" : offer.configSize > 7000 ? "warning" : "success"}>
                    {offer.configSize > 9500 ? "Near limit!" : "OK"}
                  </Badge>
                </InlineStack>
              )}
              {offer.functionMetafieldGid && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Metafield GID: {offer.functionMetafieldGid}
                </Text>
              )}
              <Button
                onClick={() => {
                  const form = document.createElement("form");
                  form.method = "POST";
                  const input = document.createElement("input");
                  input.name = "intent"; input.value = "republish_config";
                  form.appendChild(input);
                  document.body.appendChild(form);
                  form.submit();
                }}
              >
                Re-publish Function Config
              </Button>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        {/* Compiled config viewer */}
        {offer.compiledConfigJson && (
          <Layout.Section>
            <LegacyCard title="Compiled Config (JSON)" sectioned>
              <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 300, background: "#f3f4f6", padding: 12, borderRadius: 6 }}>
                {offer.compiledConfigJson}
              </pre>
            </LegacyCard>
          </Layout.Section>
        )}

        {/* Recent analytics errors */}
        {recentErrors.length > 0 && (
          <Layout.Section>
            <LegacyCard title="Recent Cart Mutation Errors (Analytics)" sectioned>
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Time", "Session", "Properties"]}
                rows={recentErrors.map((e) => [
                  new Date(e.occurred).toLocaleString(),
                  e.sessionId.slice(0, 12) + "…",
                  e.properties,
                ])}
              />
            </LegacyCard>
          </Layout.Section>
        )}

        {/* Mutation logs */}
        {mutationErrors.length > 0 && (
          <Layout.Section>
            <LegacyCard title="Recent Mutation Log Errors" sectioned>
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Time", "Type", "Source", "Error"]}
                rows={mutationErrors.map((e) => [
                  new Date(e.created).toLocaleString(),
                  e.type,
                  e.source,
                  e.error.slice(0, 80),
                ])}
              />
            </LegacyCard>
          </Layout.Section>
        )}

        {recentErrors.length === 0 && mutationErrors.length === 0 && (
          <Layout.Section>
            <Banner tone="success" title="No recent errors">
              No cart mutation errors recorded for this offer.
            </Banner>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
