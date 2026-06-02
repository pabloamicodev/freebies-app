import { useLoaderData, useNavigate, Form } from "react-router";
import {
  Page, Layout, LegacyCard, Badge, Button, ButtonGroup,
  Banner, Text, InlineStack, Tabs, BlockStack, FormLayout,
  TextField, Select, Checkbox, Box, Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const offerRows = await db
    .select()
    .from(offers)
    .where(eq(offers.id, offerId))
    .limit(1);

  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const [conditions, rewards, policy] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
  ]);

  return {
    offer: {
      ...offer,
      startsAt: offer.startsAt?.toISOString() ?? null,
      endsAt: offer.endsAt?.toISOString() ?? null,
      createdAt: offer.createdAt.toISOString(),
      updatedAt: offer.updatedAt.toISOString(),
    },
    conditions,
    rewards,
    policy: policy[0] ?? null,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];
  if (!offerId) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "update": {
      const publicTitle = formData.get("publicTitle") as string;
      const internalName = formData.get("internalName") as string;
      const priority = parseInt(formData.get("priority") as string, 10);
      await db
        .update(offers)
        .set({ publicTitle, internalName, priority, updatedAt: new Date() })
        .where(eq(offers.id, offerId));
      break;
    }
    case "publish": {
      await db.update(offers).set({ status: "active", updatedAt: new Date() }).where(eq(offers.id, offerId));
      // ── CRITICAL: Push compiled config to Shopify Function metafield ──────────
      // Enqueue offer publisher so the Rust Discount Function receives the config.
      try {
        const { offerPublishQueue } = await import("../lib/queues.server.js") as any;
        const shopRows2 = await db.select({
          myshopifyDomain: (await import("@promo/db")).shops.myshopifyDomain,
          accessTokenEncrypted: (await import("@promo/db")).shops.accessTokenEncrypted,
        })
          .from((await import("@promo/db")).shops)
          .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
          .limit(1);
        const shop2 = shopRows2[0];
        if (shop2 && offerPublishQueue) {
          await offerPublishQueue.add(`publish-offer-${offerId}`, {
            shopId: shopId ?? "",
            shopDomain: shop2.myshopifyDomain,
            accessToken: shop2.accessTokenEncrypted,
            offerId,
          }, { priority: 1, removeOnComplete: 100 });
        }
      } catch (e) {
        console.error("Failed to enqueue offer publish:", e);
        // Do not fail the request — offer is marked active in DB.
        // The offer-publisher worker will retry on next startup.
      }
      break;
    }
    case "pause": {
      await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(eq(offers.id, offerId));
      // Rebuild config with offer removed from active set
      try {
        const { offerPublishQueue } = await import("../lib/queues.server.js") as any;
        const shopRows2 = await db.select({
          myshopifyDomain: (await import("@promo/db")).shops.myshopifyDomain,
          accessTokenEncrypted: (await import("@promo/db")).shops.accessTokenEncrypted,
        })
          .from((await import("@promo/db")).shops)
          .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
          .limit(1);
        const shop2 = shopRows2[0];
        if (shop2 && offerPublishQueue) {
          await offerPublishQueue.add(`pause-rebuild-${offerId}`, {
            shopId: shopId ?? "",
            shopDomain: shop2.myshopifyDomain,
            accessToken: shop2.accessTokenEncrypted,
          }, { priority: 2 });
        }
      } catch {}
      break;
    }
    case "archive": {
      await db.update(offers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, offerId));
      // Rebuild config without archived offer
      try {
        const { offerPublishQueue } = await import("../lib/queues.server.js") as any;
        const shopRows2 = await db.select({
          myshopifyDomain: (await import("@promo/db")).shops.myshopifyDomain,
          accessTokenEncrypted: (await import("@promo/db")).shops.accessTokenEncrypted,
        })
          .from((await import("@promo/db")).shops)
          .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
          .limit(1);
        const shop2 = shopRows2[0];
        if (shop2 && offerPublishQueue) {
          await offerPublishQueue.add(`archive-rebuild-${offerId}`, {
            shopId: shopId ?? "",
            shopDomain: shop2.myshopifyDomain,
            accessToken: shop2.accessTokenEncrypted,
          }, { priority: 2 });
        }
      } catch {}
      return Response.redirect("/app/offers", 302);
    }
    case "duplicate": {
      const originalRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
      const original = originalRows[0];
      if (!original) break;
      const [newOffer] = await db
        .insert(offers)
        .values({
          ...original,
          id: undefined as any,
          internalName: `${original.internalName}-copy`,
          status: "draft",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: offers.id });
      if (newOffer) return Response.redirect(`/app/offers/${newOffer.id}`, 302);
      break;
    }
  }

  return null;
};

const STATUS_CONFIG = {
  active: { tone: "success" as const, label: "Active" },
  draft: { tone: "info" as const, label: "Draft" },
  paused: { tone: "warning" as const, label: "Paused" },
  scheduled: { tone: "attention" as const, label: "Scheduled" },
  expired: { tone: "critical" as const, label: "Expired" },
  archived: { tone: "critical" as const, label: "Archived" },
};

export default function OfferDetailPage() {
  const { offer, conditions, rewards, policy } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState(0);

  const statusConfig = STATUS_CONFIG[offer.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.draft;
  const canPublish = offer.status === "draft" || offer.status === "paused";

  const tabs = [
    { id: "conditions", content: `Conditions (${conditions.length})` },
    { id: "rewards", content: `Rewards (${rewards.length})` },
    { id: "policy", content: "Combination Policy" },
    { id: "analytics", content: "Analytics" },
  ];

  return (
    <Page
      title={offer.internalName}
      subtitle={offer.publicTitle}
      backAction={{ content: "All Offers", url: "/app/offers" }}
      titleMetadata={<Badge tone={statusConfig.tone}>{statusConfig.label}</Badge>}
      secondaryActions={[
        { content: "Duplicate", onAction: () => {} },
        { content: "Archive", destructive: true, onAction: () => {} },
      ]}
      primaryAction={
        canPublish
          ? {
              content: "Publish",
              onAction: async () => {
                const fd = new FormData();
                fd.append("intent", "publish");
                await fetch("", { method: "POST", body: fd });
                window.location.reload();
              },
            }
          : {
              content: "Pause",
              onAction: async () => {
                const fd = new FormData();
                fd.append("intent", "pause");
                await fetch("", { method: "POST", body: fd });
                window.location.reload();
              },
            }
      }
    >
      <Layout>
        {/* Warnings */}
        {conditions.length === 0 && (
          <Layout.Section>
            <Banner tone="warning" title="No conditions configured">
              This offer has no eligibility conditions. Add at least one condition before publishing.
            </Banner>
          </Layout.Section>
        )}
        {rewards.length === 0 && (
          <Layout.Section>
            <Banner tone="warning" title="No rewards configured">
              This offer has no rewards. Add at least one reward before publishing.
            </Banner>
          </Layout.Section>
        )}

        {/* Basic info */}
        <Layout.Section>
          <LegacyCard title="Offer Details" sectioned>
            <Form method="POST">
              <input type="hidden" name="intent" value="update" />
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Internal Name"
                    name="internalName"
                    defaultValue={offer.internalName}
                    autoComplete="off"
                  />
                  <TextField
                    label="Public Title"
                    name="publicTitle"
                    defaultValue={offer.publicTitle}
                    autoComplete="off"
                  />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField
                    label="Priority"
                    name="priority"
                    type="number"
                    defaultValue={String(offer.priority)}
                    autoComplete="off"
                    helpText="Lower = evaluated first"
                  />
                  <Select
                    label="Type"
                    name="type"
                    options={[
                      { label: "Gift", value: "gift" },
                      { label: "Bundle", value: "bundle" },
                      { label: "Upsell", value: "upsell" },
                      { label: "Discount", value: "discount" },
                      { label: "Booster", value: "booster" },
                    ]}
                    value={offer.type}
                    onChange={() => {}}
                    disabled
                  />
                </FormLayout.Group>
                <InlineStack align="end">
                  <Button variant="primary" submit>Save Changes</Button>
                </InlineStack>
              </FormLayout>
            </Form>
          </LegacyCard>
        </Layout.Section>

        {/* Tabs */}
        <Layout.Section>
          <LegacyCard>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
              <LegacyCard.Section>
                {selectedTab === 0 && (
                  <BlockStack gap="400">
                    {conditions.length === 0 ? (
                      <Text as="p" tone="subdued">No conditions yet. Add conditions to control when this offer qualifies.</Text>
                    ) : (
                      conditions.map((c) => (
                        <Box key={c.id} padding="400" borderWidth="025" borderColor="border" borderRadius="200">
                          <Text as="p" fontWeight="semibold">{c.conditionType}</Text>
                          <Text as="p" tone="subdued">{c.scope} · {c.operator} · {JSON.stringify(c.value)}</Text>
                        </Box>
                      ))
                    )}
                    <Button>Add Condition</Button>
                  </BlockStack>
                )}
                {selectedTab === 1 && (
                  <BlockStack gap="400">
                    {rewards.length === 0 ? (
                      <Text as="p" tone="subdued">No rewards yet. Add rewards to define what the customer receives.</Text>
                    ) : (
                      rewards.map((r) => (
                        <Box key={r.id} padding="400" borderWidth="025" borderColor="border" borderRadius="200">
                          <Text as="p" fontWeight="semibold">{r.rewardType}</Text>
                          <Text as="p" tone="subdued">
                            {r.discountType} · qty: {r.quantity ?? "—"} · auto-add: {String(r.isAutoAdd)}
                          </Text>
                        </Box>
                      ))
                    )}
                    <Button>Add Reward</Button>
                  </BlockStack>
                )}
                {selectedTab === 2 && policy && (
                  <BlockStack gap="300">
                    <Checkbox
                      label="Combines with order discounts"
                      checked={policy.combinesWithOrderDiscounts}
                      onChange={() => {}}
                    />
                    <Checkbox
                      label="Combines with product discounts"
                      checked={policy.combinesWithProductDiscounts}
                      onChange={() => {}}
                    />
                    <Checkbox
                      label="Combines with shipping discounts"
                      checked={policy.combinesWithShippingDiscounts}
                      onChange={() => {}}
                    />
                    <Checkbox
                      label="Stop lower priority offers"
                      checked={policy.stopLowerPriority}
                      onChange={() => {}}
                      helpText="When this offer qualifies, offers with higher priority numbers will not run."
                    />
                  </BlockStack>
                )}
                {selectedTab === 3 && (
                  <Text as="p" tone="subdued">
                    Analytics for this offer will appear here once it has been active.{" "}
                    <a href="/app/analytics">View all analytics →</a>
                  </Text>
                )}
              </LegacyCard.Section>
            </Tabs>
          </LegacyCard>
        </Layout.Section>

        {/* Metadata */}
        <Layout.Section variant="oneThird">
          <LegacyCard title="Offer Info" sectioned>
            <BlockStack gap="300">
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Offer ID</Text>
                <Text as="p" variant="bodySm" breakWord>{offer.id}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Created</Text>
                <Text as="p" variant="bodySm">{new Date(offer.createdAt).toLocaleDateString()}</Text>
              </Box>
              <Box>
                <Text as="p" variant="bodySm" tone="subdued">Updated</Text>
                <Text as="p" variant="bodySm">{new Date(offer.updatedAt).toLocaleDateString()}</Text>
              </Box>
              {offer.discountTags && offer.discountTags.length > 0 && (
                <Box>
                  <Text as="p" variant="bodySm" tone="subdued">Discount Tags</Text>
                  <Text as="p" variant="bodySm">{offer.discountTags.join(", ")}</Text>
                </Box>
              )}
            </BlockStack>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
