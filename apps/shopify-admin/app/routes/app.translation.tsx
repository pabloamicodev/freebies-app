/**
 * Translation management page.
 * Allows merchants to customize widget strings per locale.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, Banner, Text, Tabs, Box,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { SUPPORTED_LOCALES, type WidgetTranslations } from "@promo/shared-types";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const TRANSLATION_KEYS: Array<{ key: keyof WidgetTranslations; label: string; hint?: string }> = [
  { key: "progress.before_goal", label: "Progress bar — before goal", hint: "Use {{remaining_amount}} for the amount, {{remaining_quantity}} for quantity." },
  { key: "progress.after_goal", label: "Progress bar — after goal" },
  { key: "gift_slider.title", label: "Gift slider title" },
  { key: "gift_slider.confirm_button", label: "Gift slider confirm button" },
  { key: "gift_slider.out_of_stock", label: "Gift out of stock label" },
  { key: "gift_slider.free_label", label: "Free price label" },
  { key: "today_offer.title", label: "Today Offer widget title" },
  { key: "today_offer.button", label: "Today Offer button text" },
  { key: "volume_discount.title", label: "Volume discount title" },
  { key: "fbt.title", label: "FBT widget title" },
  { key: "fbt.add_button", label: "FBT add button", hint: "Use {{count}} for number of items." },
  { key: "upsell.no_thanks", label: "Upsell dismiss text" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { translations: {} as Record<string, Partial<WidgetTranslations>>, shopId: "" };

  const settingRows = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "translations.strings")))
    .limit(1);

  let translations: Record<string, Partial<WidgetTranslations>> = {};
  if (settingRows[0]) {
    try { translations = JSON.parse(settingRows[0].value); } catch {}
  }

  return { translations, shopId };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const shopRows = await db.select({ id: shops.id }).from(shops).where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found" };

  const formData = await request.formData();
  const locale = formData.get("locale") as string;

  const strings: Partial<WidgetTranslations> = { locale };
  for (const { key } of TRANSLATION_KEYS) {
    const val = formData.get(key) as string | null;
    if (val?.trim()) (strings as any)[key] = val.trim();
  }

  // Load existing translations
  const existing = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "translations.strings")))
    .limit(1);

  let allTranslations: Record<string, Partial<WidgetTranslations>> = {};
  if (existing[0]) {
    try { allTranslations = JSON.parse(existing[0].value); } catch {}
  }
  allTranslations[locale] = strings;

  await db.insert(appSettings)
    .values({ shopId, key: "translations.strings", value: JSON.stringify(allTranslations) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(allTranslations), updatedAt: new Date() },
    });

  return { success: true, locale };
};

export default function TranslationPage() {
  const { translations } = useLoaderData<typeof loader>();
  const [locale, setLocale] = useState("en");
  const currentStrings = translations[locale] ?? {};

  const localeOptions = SUPPORTED_LOCALES.map((l) => ({ label: l.toUpperCase(), value: l }));

  return (
    <Page title="Translations" subtitle="Customize widget text per locale">
      <Layout>
        <Layout.Section>
          <LegacyCard sectioned>
            <Select
              label="Locale"
              options={localeOptions}
              value={locale}
              onChange={setLocale}
              helpText="Select the locale to edit. Changes apply to all widgets for that locale."
            />
          </LegacyCard>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title={`Widget strings — ${locale.toUpperCase()}`} sectioned>
            <Form method="POST">
              <input type="hidden" name="locale" value={locale} />
              <FormLayout>
                {TRANSLATION_KEYS.map(({ key, label, hint }) => (
                  <TextField
                    key={key}
                    label={label}
                    name={key}
                    defaultValue={(currentStrings as any)[key] ?? ""}
                    autoComplete="off"
                    helpText={hint}
                    placeholder="Leave empty to use default English string"
                  />
                ))}
                <Button variant="primary" submit>Save {locale.toUpperCase()} Translations</Button>
              </FormLayout>
            </Form>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <LegacyCard title="Translation notes" sectioned>
            <Text as="p" variant="bodySm">
              Leave a field empty to use the default English string.
              Variable placeholders like <code>{"{{remaining_amount}}"}</code> are replaced at render time.
            </Text>
            <Box paddingBlockStart="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Configured locales: {Object.keys(translations).join(", ") || "None"}
              </Text>
            </Box>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
