/**
 * Offer Rewards Editor — Step 4 of the offer builder wizard.
 * Configure what the customer receives: gift products, discounts, shipping.
 */

import { useLoaderData, useNavigate, Form } from "react-router";
import {
  Page, Layout, LegacyCard, FormLayout, TextField, Select,
  Button, BlockStack, InlineStack, Badge, Text, Box, Checkbox, Banner, Tag,
} from "@shopify/polaris";
import { useState } from "react";
import { ProductPicker } from "../components/ProductPicker.js";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerRewards } from "@promo/db";
import { eq } from "drizzle-orm";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"]!;

  const [offerRows, rewardRows] = await Promise.all([
    db.select().from(offers).where(eq(offers.id, offerId)).limit(1),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
  ]);

  return {
    offer: offerRows[0],
    rewards: rewardRows.sort((a, b) => a.sortOrder - b.sortOrder),
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

  if (intent === "add_reward") {
    const rewardType = formData.get("rewardType") as string;
    const discountType = formData.get("discountType") as string;
    const discountValue = parseFloat(formData.get("discountValue") as string) || 0;
    const quantity = formData.get("quantity") ? parseInt(formData.get("quantity") as string, 10) : null;
    const isAutoAdd = formData.get("isAutoAdd") === "on";
    const isCustomerSelectable = formData.get("isCustomerSelectable") === "on";
    const trackMode = (formData.get("trackMode") as "product" | "variant") ?? "product";
    const label = (formData.get("label") as string) || null;
    const currencyCode = (formData.get("currencyCode") as string) || "USD";

    // Build target from variant GIDs input
    const variantGids = (formData.get("variantGids") as string)
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);

    const target = variantGids.length > 0
      ? { variantIds: variantGids }
      : { scope: "cart" };

    const existing = await db.select({ id: offerRewards.id })
      .from(offerRewards).where(eq(offerRewards.offerId, offerId));

    await db.insert(offerRewards).values({
      shopId, offerId,
      rewardType: rewardType as any,
      discountType: discountType as any,
      value: {
        amount: discountType === "percentage" ? discountValue : Math.round(discountValue * 100),
        currencyCode,
      },
      target,
      quantity,
      isAutoAdd,
      isCustomerSelectable,
      trackMode,
      sortOrder: existing.length,
      label,
    });
  }

  if (intent === "delete_reward") {
    const rewardId = formData.get("rewardId") as string;
    await db.delete(offerRewards).where(eq(offerRewards.id, rewardId));
  }

  return null;
};

const REWARD_TYPES = [
  { label: "🎁 Product Gift — add a free or discounted product", value: "product_gift" },
  { label: "💰 Order Discount — % or $ off the cart total", value: "order_discount" },
  { label: "🚚 Shipping Discount — % or $ off shipping", value: "shipping_discount" },
  { label: "🏷️ Product Discount — % or $ off specific products", value: "product_discount" },
];

const DISCOUNT_TYPES = [
  { label: "Free (100% off)", value: "free" },
  { label: "Percentage off", value: "percentage" },
  { label: "Fixed amount off", value: "fixed_amount" },
  { label: "Fixed price", value: "fixed_price" },
  { label: "Cheapest item free", value: "cheapest_item_free" },
  { label: "Most expensive item discount", value: "most_expensive_item_discount" },
];

export default function OfferRewardsPage() {
  const { offer, rewards } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [rewardType, setRewardType] = useState("product_gift");
  const [discountType, setDiscountType] = useState("free");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGiftGids, setSelectedGiftGids] = useState<string[]>([]);

  if (!offer) return <Page title="Not Found" />;

  return (
    <>
      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Select Gift Products"
        mode="variants"
        allowMultiple
        selectedIds={selectedGiftGids}
        onSelect={setSelectedGiftGids}
      />
    <Page
      title="Rewards"
      subtitle={offer.internalName}
      backAction={{ content: "← Conditions", url: `/app/offers/${offer.id}/conditions` }}
      primaryAction={{ content: "→ Widget Settings", url: `/app/offers/${offer.id}` }}
    >
      <Layout>
        {rewards.length === 0 && (
          <Layout.Section>
            <Banner tone="warning" title="No rewards configured">
              Add at least one reward before publishing this offer.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <LegacyCard title="Rewards" sectioned>
            <BlockStack gap="300">
              {rewards.map((r) => (
                <Box key={r.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                  <InlineStack align="space-between">
                    <InlineStack gap="300">
                      <Badge tone="success">{r.rewardType}</Badge>
                      <Text as="p" fontWeight="semibold">{r.discountType}</Text>
                      {r.isAutoAdd && <Badge tone="info">Auto-add</Badge>}
                      {r.isCustomerSelectable && <Badge tone="attention">Customer selects</Badge>}
                    </InlineStack>
                    <Form method="POST">
                      <input type="hidden" name="intent" value="delete_reward" />
                      <input type="hidden" name="rewardId" value={r.id} />
                      <Button tone="critical" variant="plain" submit>Remove</Button>
                    </Form>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Qty: {r.quantity ?? "unlimited"} · Target: {JSON.stringify(r.target).slice(0, 80)}
                  </Text>
                </Box>
              ))}

              {!adding && (
                <Button onClick={() => setAdding(true)}>+ Add Reward</Button>
              )}
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        {adding && (
          <Layout.Section>
            <LegacyCard title="Add Reward" sectioned>
              <Form method="POST">
                <input type="hidden" name="intent" value="add_reward" />
                <FormLayout>
                  <Select label="Reward Type" name="rewardType" options={REWARD_TYPES} value={rewardType} onChange={setRewardType} />
                  <Select label="Discount Type" name="discountType" options={DISCOUNT_TYPES} value={discountType} onChange={setDiscountType} />

                  {discountType !== "free" && discountType !== "cheapest_item_free" && discountType !== "most_expensive_item_discount" && (
                    <FormLayout.Group>
                      <TextField label="Discount Value" name="discountValue" type="number" autoComplete="off"
                        prefix={discountType === "percentage" ? "%" : "$"} />
                      <TextField label="Currency Code" name="currencyCode" defaultValue="USD" autoComplete="off" />
                    </FormLayout.Group>
                  )}
                  {(discountType === "free" || discountType === "cheapest_item_free") && (
                    <input type="hidden" name="discountValue" value="100" />
                  )}
                  {discountType === "most_expensive_item_discount" && (
                    <input type="hidden" name="discountValue" value="0" />
                  )}

                  {rewardType === "product_gift" && (
                    <>
                      {/* Product Picker — replaces raw GID textarea */}
                      <BlockStack gap="200">
                        <Text as="p" fontWeight="semibold">Gift Products</Text>
                        <InlineStack gap="200" wrap>
                          {selectedGiftGids.map((gid) => (
                            <Tag key={gid} onRemove={() => setSelectedGiftGids((prev) => prev.filter((g) => g !== gid))}>
                              {gid.split("/").pop()}
                            </Tag>
                          ))}
                        </InlineStack>
                        <Button onClick={() => setPickerOpen(true)}>
                          🎁 Select Gift Products
                        </Button>
                        <input type="hidden" name="variantGids" value={selectedGiftGids.join("\n")} />
                      </BlockStack>
                      {/* Fallback: manual GID input */}
                      <TextField
                        label="Or paste GIDs manually (one per line)"
                        name="variantGidsManual"
                        multiline={2}
                        autoComplete="off"
                        placeholder={"gid://shopify/ProductVariant/12345"}
                        helpText="Optional: paste GIDs directly if you know them."
                      />
                      <TextField label="Gift Quantity" name="quantity" type="number" defaultValue="1" autoComplete="off" />
                      <Select
                        label="Track Mode"
                        name="trackMode"
                        options={[
                          { label: "Track by Product (any variant counts)", value: "product" },
                          { label: "Track by Variant (exact variant only)", value: "variant" },
                        ]}
                      />
                      <Checkbox label="Auto-add gift to cart" name="isAutoAdd" helpText="Gift is automatically added when offer qualifies. Uncheck to show gift slider." />
                      <Checkbox label="Customer selectable" name="isCustomerSelectable" helpText="Customer can choose this gift from the gift slider." />
                    </>
                  )}

                  <TextField label="Label (optional)" name="label" autoComplete="off" placeholder="e.g. 'Choose your gift'" />

                  <InlineStack gap="300">
                    <Button variant="primary" submit>Add Reward</Button>
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
