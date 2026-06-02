/**
 * Offer Schedule editor — configure start/end dates and timezone.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, BlockStack, Text, InlineStack, Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

const TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo",
  "Asia/Singapore", "Australia/Sydney",
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const offerRows = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  const offer = offerRows[0];
  if (!offer) throw new Response("Not found", { status: 404 });
  return {
    offer: {
      id: offer.id, internalName: offer.internalName, status: offer.status,
      startsAt: offer.startsAt?.toISOString().slice(0, 16) ?? "",
      endsAt: offer.endsAt?.toISOString().slice(0, 16) ?? "",
      timezone: offer.timezone ?? "UTC",
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  const startsAtStr = formData.get("starts_at") as string;
  const endsAtStr = formData.get("ends_at") as string;
  const timezone = (formData.get("timezone") as string) || "UTC";

  await db.update(offers).set({
    startsAt: startsAtStr ? new Date(startsAtStr) : null,
    endsAt: endsAtStr ? new Date(endsAtStr) : null,
    timezone,
    updatedAt: new Date(),
  }).where(eq(offers.id, offerId));

  return null;
};

export default function OfferSchedulePage() {
  const { offer } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Schedule"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        <Layout.Section>
          <LegacyCard sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <Text as="p" tone="subdued">
                  Leave start/end dates empty for an offer that runs indefinitely.
                  Scheduled offers automatically activate/deactivate based on the configured times.
                </Text>
                <FormLayout>
                  <Select
                    label="Timezone"
                    name="timezone"
                    options={TIMEZONES.map((tz) => ({ label: tz, value: tz }))}
                    defaultValue={offer.timezone}
                    onChange={() => {}}
                    helpText="All times below are interpreted in this timezone."
                  />
                  <FormLayout.Group>
                    <TextField
                      label="Start date & time"
                      name="starts_at"
                      type="datetime-local"
                      defaultValue={offer.startsAt}
                      autoComplete="off"
                      helpText="Offer becomes active at this time."
                    />
                    <TextField
                      label="End date & time"
                      name="ends_at"
                      type="datetime-local"
                      defaultValue={offer.endsAt}
                      autoComplete="off"
                      helpText="Offer expires at this time. Leave empty for no expiry."
                    />
                  </FormLayout.Group>
                </FormLayout>
                <Button variant="primary" submit>Save Schedule</Button>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
