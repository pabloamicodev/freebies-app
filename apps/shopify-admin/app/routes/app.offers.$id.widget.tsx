/**
 * Widget / Display Settings — Step 5 of the offer builder wizard.
 * Configure widget type, placement, theme, and copy for each offer.
 */

import { useLoaderData, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, BlockStack, InlineStack, Checkbox, Text, ColorPicker,
  Badge, Box, Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, widgets, widgetPlacements } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, widgetRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(widgets).where(eq(widgets.offerId, offerId)),
  ]);

  return {
    offer: offerRows[0],
    widgets: widgetRows,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id!;

  if (intent === "add_widget") {
    const widgetType = formData.get("widgetType") as string;
    const title = formData.get("widgetTitle") as string;
    const subtitle = formData.get("widgetSubtitle") as string;
    const primaryColor = (formData.get("primaryColor") as string) || "#111111";
    const buttonText = (formData.get("buttonText") as string) || "Add to Cart";
    const placementType = formData.get("placementType") as string;

    const [newWidget] = await db.insert(widgets).values({
      shopId, offerId,
      type: widgetType as any,
      internalName: `${widgetType}-${offerId.slice(0, 8)}`,
      title: title || null,
      subtitle: subtitle || null,
      config: {
        buttonText,
        maxSelectableCount: parseInt(formData.get("maxSelectable") as string, 10) || 1,
        layout: formData.get("layout") as string || "popup",
        showPrice: formData.get("showPrice") === "on",
        showOutOfStock: formData.get("showOutOfStock") === "on",
      },
      theme: {
        primaryColor,
        buttonColor: formData.get("buttonColor") as string || primaryColor,
        textColor: formData.get("textColor") as string || "#ffffff",
        backgroundColor: formData.get("backgroundColor") as string || "#ffffff",
      },
      isEnabled: true,
    }).returning({ id: widgets.id });

    if (newWidget && placementType) {
      await db.insert(widgetPlacements).values({
        shopId, widgetId: newWidget.id,
        placementType,
        selector: formData.get("cssSelector") as string || null,
        pageRule: {
          pageType: formData.get("pageType") as string || "all",
          urlPattern: formData.get("urlPattern") as string || undefined,
        },
        sortOrder: 0, isEnabled: true,
      });
    }
  }

  if (intent === "delete_widget") {
    const widgetId = formData.get("widgetId") as string;
    await db.delete(widgets).where(eq(widgets.id, widgetId));
  }

  return null;
};

const WIDGET_TYPES = {
  gift: [
    { label: "Gift Slider — popup for gift selection", value: "gift_slider" },
    { label: "Cart Message — inline text in cart", value: "cart_message" },
    { label: "Progress Bar — show cart value progress", value: "progress_bar" },
    { label: "Gift Icon — icon on product page", value: "gift_icon" },
    { label: "Gift Thumbnail — product thumbnail on page", value: "gift_thumbnail" },
    { label: "Today Offer — floating site-wide widget", value: "today_offer_widget" },
  ],
  bundle: [
    { label: "Classic Bundle Block — inline product page", value: "classic_bundle" },
    { label: "Mix & Match Block — inline product list", value: "mix_match_bundle" },
  ],
  upsell: [
    { label: "Frequently Bought Together Block", value: "fbt" },
    { label: "Volume Discount Block — product page tiers", value: "volume_discount" },
  ],
  discount: [
    { label: "Progress Bar — show discount threshold", value: "progress_bar" },
    { label: "Cart Message — show discount message", value: "cart_message" },
    { label: "Volume Discount Block", value: "volume_discount" },
  ],
};

const PLACEMENT_TYPES = [
  { label: "Theme App Block (theme editor)", value: "theme_app_block" },
  { label: "App Embed (injected on all pages)", value: "app_embed" },
  { label: "CSS Selector Injection", value: "css_selector_injection" },
  { label: "Checkout Extension (Plus)", value: "checkout_extension" },
  { label: "Headless Mount", value: "headless_mount" },
];

const PAGE_TYPES = [
  { label: "All pages", value: "all" },
  { label: "Product pages only", value: "product" },
  { label: "Cart page only", value: "cart" },
  { label: "Collection pages", value: "collection" },
  { label: "Home page", value: "home" },
  { label: "Custom URL pattern", value: "custom" },
];

export default function OfferWidgetPage() {
  const { offer, widgets: existingWidgets } = useLoaderData<typeof loader>();
  const [adding, setAdding] = useState(false);
  const [widgetType, setWidgetType] = useState("");
  const [placementType, setPlacementType] = useState("theme_app_block");
  const [pageType, setPageType] = useState("all");

  if (!offer) return <Page title="Not Found" />;

  const availableWidgets = WIDGET_TYPES[offer.type as keyof typeof WIDGET_TYPES] ?? WIDGET_TYPES.gift;

  return (
    <Page
      title="Widget & Display Settings"
      subtitle={offer.internalName}
      backAction={{ content: "← Rewards", url: `/app/offers/${offer.id}/rewards` }}
      primaryAction={{ content: "→ Advanced Config", url: `/app/offers/${offer.id}` }}
      secondaryActions={[
        { content: "🌍 Per-Market Config", url: `/app/offers/${offer.id}/widget/market` },
      ]}
    >
      <Layout>
        <Layout.Section>
          <LegacyCard title="Configured Widgets" sectioned>
            <BlockStack gap="300">
              {existingWidgets.length === 0 ? (
                <Text as="p" tone="subdued">No widgets configured. Add a widget to display this offer to customers.</Text>
              ) : (
                existingWidgets.map((w) => (
                  <Box key={w.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <InlineStack align="space-between">
                      <InlineStack gap="300">
                        <Badge tone="success">{w.type}</Badge>
                        <Text as="p">{w.title ?? w.internalName}</Text>
                      </InlineStack>
                      <Form method="POST">
                        <input type="hidden" name="intent" value="delete_widget" />
                        <input type="hidden" name="widgetId" value={w.id} />
                        <Button tone="critical" variant="plain" submit>Remove</Button>
                      </Form>
                    </InlineStack>
                  </Box>
                ))
              )}
              {!adding && (
                <Button onClick={() => setAdding(true)}>+ Add Widget</Button>
              )}
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        {adding && (
          <Layout.Section>
            <LegacyCard title="Add Widget" sectioned>
              <Form method="POST">
                <input type="hidden" name="intent" value="add_widget" />
                <FormLayout>
                  <Select label="Widget Type" name="widgetType"
                    options={[{ label: "— Select —", value: "" }, ...availableWidgets]}
                    value={widgetType} onChange={setWidgetType} />

                  <FormLayout.Group>
                    <TextField label="Title (optional)" name="widgetTitle" autoComplete="off" placeholder="Your Free Gift" />
                    <TextField label="Subtitle (optional)" name="widgetSubtitle" autoComplete="off" />
                  </FormLayout.Group>

                  <TextField label="Button Text" name="buttonText" defaultValue="Add to Cart" autoComplete="off" />

                  {(widgetType === "gift_slider" || widgetType === "gift_thumbnail") && (
                    <TextField label="Max Selectable Gifts" name="maxSelectable" type="number" defaultValue="1" autoComplete="off" />
                  )}

                  <Divider />
                  <Text as="p" fontWeight="semibold">Theme</Text>
                  <FormLayout.Group>
                    <TextField label="Primary Color (hex)" name="primaryColor" defaultValue="#111111" autoComplete="off" />
                    <TextField label="Button Color (hex)" name="buttonColor" defaultValue="#111111" autoComplete="off" />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="Text Color (hex)" name="textColor" defaultValue="#ffffff" autoComplete="off" />
                    <TextField label="Background Color (hex)" name="backgroundColor" defaultValue="#ffffff" autoComplete="off" />
                  </FormLayout.Group>

                  <Divider />
                  <Text as="p" fontWeight="semibold">Placement</Text>
                  <Select label="Placement Type" name="placementType" options={PLACEMENT_TYPES}
                    value={placementType} onChange={setPlacementType} />
                  <Select label="Show on" name="pageType" options={PAGE_TYPES}
                    value={pageType} onChange={setPageType} />
                  {pageType === "custom" && (
                    <TextField label="URL Pattern (contains)" name="urlPattern" autoComplete="off"
                      placeholder="/collections/sale" />
                  )}
                  {placementType === "css_selector_injection" && (
                    <TextField label="CSS Selector" name="cssSelector" autoComplete="off"
                      placeholder=".cart-drawer__footer" />
                  )}

                  <InlineStack gap="300">
                    <Button variant="primary" submit>Add Widget</Button>
                    <Button onClick={() => setAdding(false)}>Cancel</Button>
                  </InlineStack>
                </FormLayout>
              </Form>
            </LegacyCard>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
