/**
 * Boosters — Today Offer widget and Progress Bar configuration.
 * Boosters are offers that "boost" visibility of existing offers
 * via floating widgets, progress bars, and cart messages.
 */

import { useLoaderData, useNavigate, Form } from "react-router";
import {
  Page, Layout, LegacyCard, Text, BlockStack, InlineStack, Badge,
  Button, EmptyState, IndexTable, useIndexResourceState, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, offers, offerRewards, widgets } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const [shopRow] = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";

  const boosterOffers = await db.select().from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.type, "booster")))
    .orderBy(offers.priority);

  const boosterWidgets = await db.select().from(widgets)
    .where(eq(widgets.shopId, shopId));

  return {
    boosters: boosterOffers.map((o) => ({
      id: o.id,
      internalName: o.internalName,
      publicTitle: o.publicTitle,
      status: o.status,
      priority: o.priority,
      updatedAt: o.updatedAt.toISOString(),
    })),
    widgets: boosterWidgets.filter((w) =>
      ["today_offer_widget", "today_offer_block", "progress_bar"].includes(w.type)
    ).map((w) => ({
      id: w.id,
      type: w.type,
      internalName: w.internalName,
      isEnabled: w.isEnabled,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const widgetId = formData.get("widgetId") as string;

  if (intent === "toggle_widget") {
    const enabled = formData.get("enabled") === "true";
    await db.update(widgets).set({ isEnabled: enabled, updatedAt: new Date() })
      .where(eq(widgets.id, widgetId));
  }
  return null;
};

const STATUS_BADGE: Record<string, { tone: any; label: string }> = {
  active: { tone: "success", label: "Active" },
  draft: { tone: "info", label: "Draft" },
  paused: { tone: "warning", label: "Paused" },
  archived: { tone: "critical", label: "Archived" },
};

const WIDGET_TYPE_LABEL: Record<string, string> = {
  today_offer_widget: "🚀 Today Offer (Floating)",
  today_offer_block: "📌 Today Offer (Inline Block)",
  progress_bar: "📊 Progress Bar",
};

export default function BoostersPage() {
  const { boosters, widgets: boosterWidgets } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <Page
      title="Boosters"
      subtitle="Today Offer widgets and progress bars that promote active offers"
      primaryAction={{ content: "Create Booster", url: "/app/offers/new?type=booster" }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="What are Boosters?">
            Boosters are floating widgets and progress bars that increase visibility of your active
            gift, bundle, and discount offers. They do not create new promotions — they promote existing ones.
          </Banner>
        </Layout.Section>

        {/* Active widgets */}
        <Layout.Section>
          <LegacyCard title="Configured Widgets" sectioned>
            {boosterWidgets.length === 0 ? (
              <Text as="p" tone="subdued">
                No booster widgets configured. Create a booster offer and add a Today Offer or Progress Bar widget.
              </Text>
            ) : (
              <BlockStack gap="300">
                {boosterWidgets.map((w) => (
                  <InlineStack key={w.id} gap="300" align="space-between">
                    <InlineStack gap="200">
                      <Text as="p" fontWeight="semibold">{WIDGET_TYPE_LABEL[w.type] ?? w.type}</Text>
                      <Text as="p" tone="subdued">{w.internalName}</Text>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Badge tone={w.isEnabled ? "success" : "critical"}>
                        {w.isEnabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Form method="POST">
                        <input type="hidden" name="intent" value="toggle_widget" />
                        <input type="hidden" name="widgetId" value={w.id} />
                        <input type="hidden" name="enabled" value={String(!w.isEnabled)} />
                        <Button size="slim" submit tone={w.isEnabled ? "critical" : "success"}>
                          {w.isEnabled ? "Disable" : "Enable"}
                        </Button>
                      </Form>
                    </InlineStack>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </LegacyCard>
        </Layout.Section>

        {/* Booster offers */}
        <Layout.Section>
          <LegacyCard title="Booster Offers">
            {boosters.length === 0 ? (
              <LegacyCard.Section>
                <EmptyState
                  heading="No booster offers yet"
                  action={{ content: "Create Booster", url: "/app/offers/new?type=booster" }}
                  image=""
                >
                  <p>Create a booster to add Today Offer widgets and progress bars to your store.</p>
                </EmptyState>
              </LegacyCard.Section>
            ) : (
              <IndexTable
                resourceName={{ singular: "booster", plural: "boosters" }}
                itemCount={boosters.length}
                headings={[
                  { title: "Name" },
                  { title: "Status" },
                  { title: "Priority" },
                  { title: "Updated" },
                ]}
                selectable={false}
              >
                {boosters.map((booster, i) => {
                  const badge = STATUS_BADGE[booster.status] ?? STATUS_BADGE.draft!;
                  return (
                    <IndexTable.Row
                      id={booster.id}
                      key={booster.id}
                      position={i}
                      onClick={() => navigate(`/app/offers/${booster.id}`)}
                    >
                      <IndexTable.Cell>
                        <Text as="p" fontWeight="semibold">{booster.internalName}</Text>
                        <Text as="p" tone="subdued" variant="bodySm">{booster.publicTitle}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{booster.priority}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {new Date(booster.updatedAt).toLocaleDateString()}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </LegacyCard>
        </Layout.Section>

        {/* Quick setup guide */}
        <Layout.Section variant="oneThird">
          <LegacyCard title="How to set up a Booster" sectioned>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm">
                <strong>1.</strong> Create a Booster offer above.
              </Text>
              <Text as="p" variant="bodySm">
                <strong>2.</strong> Add a "Today Offer" or "Progress Bar" widget in the offer settings.
              </Text>
              <Text as="p" variant="bodySm">
                <strong>3.</strong> Link to existing gift/bundle/discount offers so the booster promotes them.
              </Text>
              <Text as="p" variant="bodySm">
                <strong>4.</strong> Publish the booster — the widget will appear on your store automatically (if App Embed is enabled).
              </Text>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
