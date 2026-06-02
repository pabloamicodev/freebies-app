/**
 * Multi-Currency Configuration — configure per-currency thresholds and
 * fixed discount amounts for each active Shopify Market.
 *
 * Accessible from the offer detail page → "Multi-Currency" tab.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Button,
  Text, BlockStack, InlineStack, Badge, Box, Banner, DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const [offerRows, conditionRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerConditions).where(
      and(eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value"))
    ).limit(1),
  ]);

  // Fetch markets from Shopify Admin API
  let markets: Array<{ id: string; name: string; currencyCode: string; handle: string }> = [];
  try {
    const marketsRes = await admin.graphql(`
      query {
        markets(first: 20) {
          nodes { id name handle currencySettings { baseCurrency { currencyCode } } }
        }
      }
    `);
    const marketsData = await marketsRes.json() as any;
    markets = marketsData.data?.markets?.nodes?.map((m: any) => ({
      id: m.id,
      name: m.name,
      handle: m.handle,
      currencyCode: m.currencySettings.baseCurrency.currencyCode,
    })) ?? [];
  } catch {
    // Markets API unavailable
  }

  const condition = conditionRows[0];
  const existingValue = (condition?.value ?? {}) as Record<string, unknown>;
  const currencyOverrides = (existingValue["currencyOverrides"] ?? {}) as Record<string, number>;

  return {
    offer: offerRows[0],
    offerId,
    markets,
    currencyOverrides,
    baseThresholdCents: (existingValue["thresholdCents"] as number) ?? 0,
    baseCurrency: (existingValue["currencyCode"] as string) ?? "USD",
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();

  // Build currency overrides from form
  const overrides: Record<string, number> = {};
  const currencies = formData.getAll("currency[]") as string[];
  const thresholds = formData.getAll("threshold_cents[]") as string[];

  for (let i = 0; i < currencies.length; i++) {
    const currency = currencies[i]?.toUpperCase();
    const cents = Math.round(parseFloat(thresholds[i] ?? "0") * 100);
    if (currency && cents > 0) {
      overrides[currency] = cents;
    }
  }

  // Update the cart_value condition with currency overrides
  const existing = await db.select()
    .from(offerConditions)
    .where(and(eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value")))
    .limit(1);

  if (existing[0]) {
    const currentValue = existing[0].value as Record<string, unknown>;
    await db.update(offerConditions)
      .set({ value: { ...currentValue, currencyOverrides: overrides }, updatedAt: new Date() })
      .where(eq(offerConditions.id, existing[0].id));
  }

  return { success: true };
};

export default function MultiCurrencyPage() {
  const { offer, markets, currencyOverrides, baseThresholdCents, baseCurrency } = useLoaderData<typeof loader>();

  if (!offer) return <Page title="Not Found" />;

  const baseThreshold = baseThresholdCents / 100;

  return (
    <Page
      title="Multi-Currency Thresholds"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Base threshold">
            Store currency ({baseCurrency}): ${baseThreshold.toFixed(2)}. Buyers in markets with other currencies
            will use the exchange rate automatically if no custom override is set.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Per-Currency Thresholds" sectioned>
            <Form method="POST">
              <BlockStack gap="400">
                <Text as="p" tone="subdued">
                  Set custom thresholds for each market currency. Leave empty to use auto-converted base threshold.
                </Text>

                {markets.map((market, i) => (
                  <Box key={market.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <InlineStack gap="400" align="center">
                      <div style={{ minWidth: 120 }}>
                        <Text as="p" fontWeight="semibold">{market.name}</Text>
                        <Badge>{market.currencyCode}</Badge>
                      </div>
                      <input type="hidden" name="currency[]" value={market.currencyCode} />
                      <TextField
                        label={`Threshold (${market.currencyCode})`}
                        name="threshold_cents[]"
                        type="number"
                        defaultValue={
                          currencyOverrides[market.currencyCode]
                            ? (currencyOverrides[market.currencyCode]! / 100).toFixed(2)
                            : ""
                        }
                        autoComplete="off"
                        prefix={market.currencyCode}
                        placeholder={`Auto-convert from $${baseThreshold.toFixed(2)} ${baseCurrency}`}
                      />
                    </InlineStack>
                  </Box>
                ))}

                {markets.length === 0 && (
                  <Text as="p" tone="subdued">No markets configured. Add Shopify Markets in your store settings.</Text>
                )}

                <Button variant="primary" submit>Save Currency Thresholds</Button>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
