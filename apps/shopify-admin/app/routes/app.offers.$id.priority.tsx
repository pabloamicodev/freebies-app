/**
 * Priority and stacking configuration for an offer.
 * Shows which other active offers would conflict or be blocked.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, TextField, Checkbox, Button,
  BlockStack, Text, InlineStack, Badge, DataTable, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerCombinationPolicies } from "@promo/db";
import { eq, and, ne } from "drizzle-orm";
import { detectConflicts } from "../lib/conflict-detection.server.js";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

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

  const [offerRows, policyRows, otherActiveOffers] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)).limit(1),
    db.select({ id: offers.id, internalName: offers.internalName, priority: offers.priority, type: offers.type })
      .from(offers)
      .where(and(eq(offers.shopId, shopId), eq(offers.status, "active"), ne(offers.id, offerId)))
      .orderBy(offers.priority),
  ]);

  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });

  const conflicts = await detectConflicts(shopId);
  const offerConflicts = conflicts.filter((c) => c.offerIds.includes(offerId));

  return {
    offer: { id: offer.id, internalName: offer.internalName, priority: offer.priority, status: offer.status },
    policy: policyRows[0] ?? null,
    otherActiveOffers: otherActiveOffers.map((o) => ({
      id: o.id,
      name: o.internalName,
      priority: o.priority,
      type: o.type,
      wouldBeBlocked: (policyRows[0]?.stopLowerPriority ?? false) && o.priority > offer.priority,
    })),
    conflicts: offerConflicts,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  const newPriority = parseInt(formData.get("priority") as string, 10);
  const stopLowerPriority = formData.get("stop_lower_priority") === "on";

  await db.update(offers).set({ priority: newPriority, updatedAt: new Date() }).where(eq(offers.id, offerId));
  await db.update(offerCombinationPolicies)
    .set({ stopLowerPriority, updatedAt: new Date() })
    .where(eq(offerCombinationPolicies.offerId, offerId));

  return null;
};

export default function OfferPriorityPage() {
  const { offer, policy, otherActiveOffers, conflicts } = useLoaderData<typeof loader>();

  const blockedOffers = otherActiveOffers.filter((o) => o.wouldBeBlocked);

  return (
    <Page
      title="Priority & Stacking"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        {conflicts.length > 0 && (
          <Layout.Section>
            {conflicts.map((c, i) => (
              <Banner key={i} tone={c.severity === "error" ? "critical" : "warning"} title={`Conflict: ${c.type}`}>
                {c.message}
              </Banner>
            ))}
          </Layout.Section>
        )}

        <Layout.Section>
          <LegacyCard title="Priority Configuration" sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <TextField
                  label="Priority"
                  name="priority"
                  type="number"
                  defaultValue={String(offer.priority)}
                  autoComplete="off"
                  helpText="Lower number = evaluated first. Offer with priority 10 runs before priority 100."
                />
                <Checkbox
                  label="Stop lower-priority offers when this offer qualifies"
                  name="stop_lower_priority"
                  checked={policy?.stopLowerPriority ?? false}
                  onChange={() => {}}
                  helpText="When enabled, all active offers with higher priority numbers will be skipped if this offer qualifies."
                />
                {(policy?.stopLowerPriority || blockedOffers.length > 0) && (
                  <Banner tone="info" title="Offers that would be blocked">
                    The following active offers would NOT run when this offer qualifies:
                    {blockedOffers.map((o) => (
                      <p key={o.id}>• {o.name} (priority {o.priority})</p>
                    ))}
                  </Banner>
                )}
                <Button variant="primary" submit>Save Priority Settings</Button>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>

        {otherActiveOffers.length > 0 && (
          <Layout.Section>
            <LegacyCard title="Other Active Offers (by priority)" sectioned>
              <DataTable
                columnContentTypes={["numeric", "text", "text", "text"]}
                headings={["Priority", "Name", "Type", "Status"]}
                rows={otherActiveOffers.map((o) => [
                  String(o.priority),
                  o.name,
                  o.type,
                  o.wouldBeBlocked ? "Would be blocked by this offer" : "Runs alongside this offer",
                ])}
              />
            </LegacyCard>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
