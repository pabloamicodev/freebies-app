/**
 * Offer Conditions Editor — Step 2-3 of the offer builder wizard.
 * Allows adding/editing main conditions and subconditions with a
 * validated form for each condition type.
 */

import { useLoaderData, useNavigate, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, BlockStack, InlineStack, Badge, Text, Box, Divider, Banner, Tag,
} from "@shopify/polaris";
import { useState } from "react";
import { ProductPicker } from "../components/ProductPicker.js";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, conditionRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
  ]);

  return {
    offer: offerRows[0],
    conditions: conditionRows.sort((a, b) => a.sortOrder - b.sortOrder),
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

  if (intent === "add_condition") {
    const conditionType = formData.get("conditionType") as string;
    const scope = formData.get("scope") as "main" | "sub";

    // Build value object based on condition type
    let value: Record<string, unknown> = {};
    switch (conditionType) {
      case "cart_value":
        value = {
          thresholdCents: Math.round(parseFloat(formData.get("threshold") as string) * 100),
          currencyCode: formData.get("currencyCode") ?? "USD",
          includeGiftValues: formData.get("includeGiftValues") === "on",
        };
        break;
      case "cart_quantity":
        value = {
          minQuantity: parseInt(formData.get("minQty") as string, 10),
          maxQuantity: formData.get("maxQty") ? parseInt(formData.get("maxQty") as string, 10) : undefined,
          includeGiftValues: false,
        };
        break;
      case "cart_value_multiplier":
        value = {
          thresholdCents: Math.round(parseFloat(formData.get("threshold") as string) * 100),
          currencyCode: formData.get("currencyCode") ?? "USD",
          maxMultiplier: formData.get("maxMultiplier") ? parseInt(formData.get("maxMultiplier") as string, 10) : undefined,
          includeGiftValues: false,
        };
        break;
      case "customer_tags":
        value = {
          includeTags: (formData.get("includeTags") as string).split(",").map((t) => t.trim()).filter(Boolean),
          excludeTags: (formData.get("excludeTags") as string).split(",").map((t) => t.trim()).filter(Boolean),
          treatGuestAsNoTags: formData.get("treatGuestAsNoTags") === "on",
        };
        break;
      case "order_history_total_spent":
        value = {
          type: "total_spent",
          operator: formData.get("operator") as string,
          valueCents: Math.round(parseFloat(formData.get("orderValue") as string) * 100),
        };
        break;
      case "one_use_per_customer":
        value = {};
        break;
      case "markets":
        value = {
          includeMarketIds: (formData.get("includeMarkets") as string).split(",").map((m) => m.trim()).filter(Boolean),
          excludeMarketIds: (formData.get("excludeMarkets") as string).split(",").map((m) => m.trim()).filter(Boolean),
        };
        break;
      case "customer_location":
        value = {
          includeCountryCodes: (formData.get("includeCountries") as string).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
          excludeCountryCodes: (formData.get("excludeCountries") as string).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
        };
        break;
      case "sales_channels":
        value = { channels: formData.getAll("channels[]") as string[] };
        break;
    }

    const existingCount = await db.select({ id: offerConditions.id })
      .from(offerConditions).where(eq(offerConditions.offerId, offerId));

    await db.insert(offerConditions).values({
      shopId, offerId,
      scope,
      conditionType,
      operator: "gte",
      value,
      sortOrder: existingCount.length,
      isEnabled: true,
    });
  }

  if (intent === "delete_condition") {
    const conditionId = formData.get("conditionId") as string;
    await db.delete(offerConditions).where(eq(offerConditions.id, conditionId));
  }

  return null;
};

const MAIN_CONDITION_TYPES = [
  { label: "Cart Value — spend threshold", value: "cart_value" },
  { label: "Cart Quantity — item count threshold", value: "cart_quantity" },
  { label: "Cart Value Multiplier — earn gifts per $ spent", value: "cart_value_multiplier" },
  { label: "Specific Product — must contain selected products", value: "specific_product" },
  { label: "Pack of Products — all products must be present", value: "pack_of_products" },
];

const SUB_CONDITION_TYPES = [
  { label: "Customer Tags", value: "customer_tags" },
  { label: "Order History — total spent", value: "order_history_total_spent" },
  { label: "Order History — total orders", value: "order_history_total_orders" },
  { label: "One Use Per Customer", value: "one_use_per_customer" },
  { label: "Shopify Markets", value: "markets" },
  { label: "Country / IP location", value: "customer_location" },
  { label: "Sales Channel", value: "sales_channels" },
  { label: "Subscription Products Only", value: "subscription_product_type" },
  { label: "Specific Link / Magic URL", value: "specific_link" },
];

const SCOPE_BADGE: Record<string, "info" | "attention"> = {
  main: "info",
  sub: "attention",
};

export default function OfferConditionsPage() {
  const { offer, conditions } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [addingScope, setAddingScope] = useState<"main" | "sub" | null>(null);
  const [selectedType, setSelectedType] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"required" | "exclude" | "gift">("required");
  const [requiredVariantGids, setRequiredVariantGids] = useState<string[]>([]);
  const [excludeVariantGids, setExcludeVariantGids] = useState<string[]>([]);
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [minQtyPerProduct, setMinQtyPerProduct] = useState("1");

  if (!offer) return <Page title="Not Found" />;

  // Render: ProductPicker modal + main page
  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerTarget === "exclude" ? "Select Products to Exclude" : "Select Required Products"}
        mode="variants"
        allowMultiple
        selectedIds={pickerTarget === "exclude" ? excludeVariantGids : requiredVariantGids}
        onSelect={(gids) => {
          if (pickerTarget === "exclude") setExcludeVariantGids(gids);
          else setRequiredVariantGids(gids);
        }}
      />
    <Page
      title="Conditions"
      subtitle={offer.internalName}
      backAction={{ content: "Back to Offer", url: `/app/offers/${offer.id}` }}
      primaryAction={{ content: "→ Configure Rewards", url: `/app/offers/${offer.id}/rewards` }}
    >
      <Layout>
        {conditions.length === 0 && (
          <Layout.Section>
            <Banner tone="warning" title="No conditions — this offer will always qualify">
              Add at least one main condition before publishing.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <LegacyCard title="Conditions" sectioned>
            <BlockStack gap="300">
              {conditions.map((c) => (
                <Box key={c.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                  <InlineStack align="space-between">
                    <InlineStack gap="300">
                      <Badge tone={SCOPE_BADGE[c.scope] ?? "info"}>{c.scope}</Badge>
                      <Text as="p" fontWeight="semibold">{c.conditionType}</Text>
                    </InlineStack>
                    <Form method="POST">
                      <input type="hidden" name="intent" value="delete_condition" />
                      <input type="hidden" name="conditionId" value={c.id} />
                      <Button tone="critical" variant="plain" submit>Remove</Button>
                    </Form>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">{JSON.stringify(c.value)}</Text>
                </Box>
              ))}

              <InlineStack gap="300">
                <Button onClick={() => { setAddingScope("main"); setSelectedType(""); }}>
                  + Add Main Condition
                </Button>
                <Button onClick={() => { setAddingScope("sub"); setSelectedType(""); }}>
                  + Add Sub-Condition
                </Button>
              </InlineStack>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        {addingScope && (
          <Layout.Section>
            <LegacyCard title={`Add ${addingScope === "main" ? "Main" : "Sub"} Condition`} sectioned>
              <Form method="POST">
                <input type="hidden" name="intent" value="add_condition" />
                <input type="hidden" name="scope" value={addingScope} />
                <FormLayout>
                  <Select
                    label="Condition Type"
                    name="conditionType"
                    options={[{ label: "— Select —", value: "" }, ...(addingScope === "main" ? MAIN_CONDITION_TYPES : SUB_CONDITION_TYPES)]}
                    value={selectedType}
                    onChange={setSelectedType}
                  />

                  {/* Condition-specific fields */}
                  {(selectedType === "cart_value" || selectedType === "cart_value_multiplier") && (
                    <>
                      <TextField label="Threshold ($)" name="threshold" type="number" autoComplete="off" />
                      <TextField label="Currency Code" name="currencyCode" value={currencyCode} onChange={setCurrencyCode} autoComplete="off" />
                      {selectedType === "cart_value_multiplier" && (
                        <TextField label="Max multiplier (optional)" name="maxMultiplier" type="number" autoComplete="off" />
                      )}
                    </>
                  )}

                  {selectedType === "cart_quantity" && (
                    <>
                      <TextField label="Min quantity" name="minQty" type="number" autoComplete="off" />
                      <TextField label="Max quantity (optional)" name="maxQty" type="number" autoComplete="off" />
                    </>
                  )}

                  {/* specific_product — product picker */}
                  {(selectedType === "specific_product" || selectedType === "pack_of_products") && (
                    <BlockStack gap="300">
                      <Text as="p" fontWeight="semibold">
                        {selectedType === "specific_product" ? "Required products" : "Pack products (all must be present)"}
                      </Text>
                      <InlineStack gap="200" wrap>
                        {requiredVariantGids.map((gid) => (
                          <Tag key={gid} onRemove={() => setRequiredVariantGids((prev) => prev.filter((g) => g !== gid))}>
                            {gid.split("/").pop()}
                          </Tag>
                        ))}
                      </InlineStack>
                      <Button onClick={() => { setPickerTarget("required"); setPickerOpen(true); }}>
                        + Select Products
                      </Button>
                      <input type="hidden" name="requiredVariantGids" value={requiredVariantGids.join(",")} />
                      <TextField
                        label="Min quantity per product"
                        name="minQtyPerProduct"
                        type="number"
                        value={minQtyPerProduct}
                        onChange={setMinQtyPerProduct}
                        autoComplete="off"
                      />
                    </BlockStack>
                  )}

                  {/* exclude_products — product picker */}
                  {selectedType === "exclude_products" && (
                    <BlockStack gap="300">
                      <Text as="p" fontWeight="semibold">Excluded products</Text>
                      <InlineStack gap="200" wrap>
                        {excludeVariantGids.map((gid) => (
                          <Tag key={gid} onRemove={() => setExcludeVariantGids((prev) => prev.filter((g) => g !== gid))}>
                            {gid.split("/").pop()}
                          </Tag>
                        ))}
                      </InlineStack>
                      <Button onClick={() => { setPickerTarget("exclude"); setPickerOpen(true); }}>
                        + Select Products to Exclude
                      </Button>
                      <input type="hidden" name="excludeVariantGids" value={excludeVariantGids.join(",")} />
                    </BlockStack>
                  )}

                  {selectedType === "customer_tags" && (
                    <>
                      <TextField label="Include tags (comma-separated)" name="includeTags" autoComplete="off" placeholder="vip, wholesale" />
                      <TextField label="Exclude tags (comma-separated)" name="excludeTags" autoComplete="off" />
                    </>
                  )}

                  {selectedType === "customer_location" && (
                    <>
                      <TextField label="Include country codes (comma-separated)" name="includeCountries" autoComplete="off" placeholder="US, CA, GB" />
                      <TextField label="Exclude country codes (comma-separated)" name="excludeCountries" autoComplete="off" />
                    </>
                  )}

                  {selectedType === "markets" && (
                    <>
                      <TextField label="Include Market IDs (comma-separated)" name="includeMarkets" autoComplete="off" />
                      <TextField label="Exclude Market IDs (comma-separated)" name="excludeMarkets" autoComplete="off" />
                    </>
                  )}

                  {selectedType === "order_history_total_spent" && (
                    <TextField label="Minimum total spent ($)" name="orderValue" type="number" autoComplete="off" />
                  )}

                  {selectedType && (
                    <InlineStack gap="300">
                      <Button variant="primary" submit>Add Condition</Button>
                      <Button onClick={() => setAddingScope(null)}>Cancel</Button>
                    </InlineStack>
                  )}
                </FormLayout>
              </Form>
            </LegacyCard>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  </>
  );
}
