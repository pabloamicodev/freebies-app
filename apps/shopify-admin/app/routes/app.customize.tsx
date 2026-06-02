/**
 * Customize — global widget theme and default copy settings.
 * Controls colors, fonts, and default strings across all widgets.
 * Matches BOGOS's "Customize" section.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField,
  Button, BlockStack, Text, Divider, InlineStack, Select, Banner,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const THEME_SETTINGS_KEY = "widget.global_theme";

const DEFAULTS = {
  primaryColor: "#111111",
  accentColor: "#059669",
  buttonColor: "#111111",
  buttonTextColor: "#ffffff",
  backgroundColor: "#ffffff",
  textColor: "#111111",
  borderRadius: "8",
  fontFamily: "inherit",
  giftsLabel: "Free Gift",
  sliderTitle: "Choose Your Gift",
  progressBeforeGoal: "Spend {{remaining_amount}} more for a free gift!",
  progressAfterGoal: "🎁 You've unlocked your free gift!",
  todayOfferTitle: "Today's Deals",
  addToCartText: "Add to Cart",
  noThanksText: "No thanks",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const [shopRow] = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";

  const [settingRow] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, THEME_SETTINGS_KEY)))
    .limit(1);

  let theme = DEFAULTS;
  if (settingRow?.value) {
    try { theme = { ...DEFAULTS, ...JSON.parse(settingRow.value) }; } catch {}
  }

  return { shopId, theme };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const [shopRow] = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);
  const shopId = shopRow?.id ?? "";
  const formData = await request.formData();

  const theme: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    theme[key] = value as string;
  }

  await db.insert(appSettings)
    .values({ shopId, key: THEME_SETTINGS_KEY, value: JSON.stringify(theme) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(theme), updatedAt: new Date() },
    });

  return { success: true };
};

export default function CustomizePage() {
  const { theme } = useLoaderData<typeof loader>();
  const [primaryColor, setPrimaryColor] = useState(theme.primaryColor);
  const [accentColor, setAccentColor] = useState(theme.accentColor);
  const [buttonColor, setButtonColor] = useState(theme.buttonColor);

  return (
    <Page title="Customize" subtitle="Global widget appearance and default copy">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="These settings apply globally to all widgets">
            Individual offers can override colors and copy in their widget settings.
            Changes here are applied immediately on the next page load.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Form method="POST">
            <BlockStack gap="500">
              {/* ── Colors ───────────────────────────────────────────────── */}
              <LegacyCard title="Colors" sectioned>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Primary color (buttons, borders)"
                      name="primaryColor"
                      value={primaryColor}
                      onChange={setPrimaryColor}
                      autoComplete="off"
                      prefix={
                        <div style={{
                          width: 16, height: 16, borderRadius: 4,
                          background: primaryColor, border: "1px solid #e5e7eb"
                        }} />
                      }
                      helpText="Used for button backgrounds, progress bar fill, and selected states."
                    />
                    <TextField
                      label="Accent / success color"
                      name="accentColor"
                      value={accentColor}
                      onChange={setAccentColor}
                      autoComplete="off"
                      prefix={
                        <div style={{
                          width: 16, height: 16, borderRadius: 4,
                          background: accentColor, border: "1px solid #e5e7eb"
                        }} />
                      }
                      helpText="Used for 'Free', success states, and discount labels."
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField
                      label="Button color"
                      name="buttonColor"
                      defaultValue={theme.buttonColor}
                      autoComplete="off"
                      prefix={<div style={{ width: 16, height: 16, borderRadius: 4, background: buttonColor, border: "1px solid #e5e7eb" }} />}
                    />
                    <TextField
                      label="Button text color"
                      name="buttonTextColor"
                      defaultValue={theme.buttonTextColor}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField
                      label="Widget background color"
                      name="backgroundColor"
                      defaultValue={theme.backgroundColor}
                      autoComplete="off"
                    />
                    <TextField
                      label="Text color"
                      name="textColor"
                      defaultValue={theme.textColor}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                </FormLayout>
              </LegacyCard>

              {/* ── Typography ───────────────────────────────────────────── */}
              <LegacyCard title="Typography & Shape" sectioned>
                <FormLayout>
                  <Select
                    label="Font family"
                    name="fontFamily"
                    options={[
                      { label: "Inherit from theme (recommended)", value: "inherit" },
                      { label: "System UI", value: "system-ui, sans-serif" },
                      { label: "Inter", value: "Inter, sans-serif" },
                      { label: "Helvetica Neue", value: "'Helvetica Neue', sans-serif" },
                    ]}
                    value={theme.fontFamily}
                    onChange={() => {}}
                  />
                  <TextField
                    label="Border radius (px)"
                    name="borderRadius"
                    type="number"
                    defaultValue={theme.borderRadius}
                    autoComplete="off"
                    helpText="Controls rounded corners on widgets and buttons. 0 = square, 8 = slightly rounded, 999 = pill."
                  />
                </FormLayout>
              </LegacyCard>

              {/* ── Default Copy ──────────────────────────────────────────── */}
              <LegacyCard title="Default Widget Copy" sectioned>
                <Text as="p" tone="subdued">
                  These strings are used across all widgets unless overridden per-offer or per-translation.
                  Use <code>{"{{remaining_amount}}"}</code>, <code>{"{{remaining_quantity}}"}</code> as dynamic values.
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Gift label"
                      name="giftsLabel"
                      defaultValue={theme.giftsLabel}
                      autoComplete="off"
                      placeholder="Free Gift"
                    />
                    <TextField
                      label="Gift slider title"
                      name="sliderTitle"
                      defaultValue={theme.sliderTitle}
                      autoComplete="off"
                      placeholder="Choose Your Gift"
                    />
                  </FormLayout.Group>
                  <TextField
                    label="Progress bar — before goal"
                    name="progressBeforeGoal"
                    defaultValue={theme.progressBeforeGoal}
                    autoComplete="off"
                    helpText="Shown while cart hasn't reached the threshold yet."
                  />
                  <TextField
                    label="Progress bar — after goal"
                    name="progressAfterGoal"
                    defaultValue={theme.progressAfterGoal}
                    autoComplete="off"
                    helpText="Shown when the cart has reached the threshold."
                  />
                  <FormLayout.Group>
                    <TextField
                      label="Today Offer widget title"
                      name="todayOfferTitle"
                      defaultValue={theme.todayOfferTitle}
                      autoComplete="off"
                    />
                    <TextField
                      label="Add to cart button text"
                      name="addToCartText"
                      defaultValue={theme.addToCartText}
                      autoComplete="off"
                    />
                  </FormLayout.Group>
                  <TextField
                    label="Upsell dismiss text"
                    name="noThanksText"
                    defaultValue={theme.noThanksText}
                    autoComplete="off"
                    placeholder="No thanks"
                  />
                </FormLayout>
              </LegacyCard>

              <InlineStack align="end" gap="300">
                <Button variant="primary" submit>Save Customization</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>

        {/* Preview */}
        <Layout.Section variant="oneThird">
          <LegacyCard title="Preview" sectioned>
            <div style={{ fontFamily: theme.fontFamily }}>
              {/* Gift slider preview */}
              <div style={{
                border: `2px solid ${primaryColor}`, borderRadius: `${theme.borderRadius}px`,
                padding: 12, marginBottom: 12, background: theme.backgroundColor,
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px", color: theme.textColor }}>
                  {theme.sliderTitle}
                </p>
                <div style={{
                  display: "flex", gap: 8, padding: "8px 10px",
                  border: `2px solid ${primaryColor}`, borderRadius: `${theme.borderRadius}px`,
                  alignItems: "center",
                }}>
                  <div style={{ width: 40, height: 40, background: "#f3f4f6", borderRadius: 4 }} />
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 600, margin: 0, color: theme.textColor }}>Sample Gift</p>
                    <p style={{ fontSize: 11, color: accentColor, margin: 0, fontWeight: 700 }}>Free</p>
                  </div>
                </div>
                <button style={{
                  marginTop: 10, width: "100%", padding: "8px 16px",
                  background: buttonColor, color: theme.buttonTextColor, border: "none",
                  borderRadius: `${theme.borderRadius}px`, fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}>
                  {theme.addToCartText}
                </button>
              </div>

              {/* Progress bar preview */}
              <div style={{ marginBottom: 12 }}>
                <p style={{ fontSize: 12, color: theme.textColor, marginBottom: 6 }}>
                  {theme.progressBeforeGoal.replace("{{remaining_amount}}", "$25.00")}
                </p>
                <div style={{ background: "#e5e7eb", borderRadius: 999, height: 6 }}>
                  <div style={{ width: "60%", background: primaryColor, height: "100%", borderRadius: 999 }} />
                </div>
              </div>
            </div>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
