/**
 * CSV Import page for bulk offer creation.
 * Parses CSV, validates each row, shows diff preview, creates offers in draft.
 */

import { Form, useActionData, useNavigate } from "react-router";
import {
  Page, Layout, LegacyCard, Button, Text, BlockStack, Banner,
  DataTable, Badge, InlineStack, DropZone,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq } from "drizzle-orm";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const formData = await request.formData();
  const csvContent = formData.get("csvContent") as string;

  if (!csvContent) return { error: "No CSV content provided", created: [], errors: [] };

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id;
  if (!shopId) return { error: "Shop not found", created: [], errors: [] };

  const lines = csvContent.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { error: "CSV must have header and at least one row", created: [], errors: [] };

  const headers = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const created: string[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i]!.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });

    const internalName = row["internal_name"];
    const publicTitle = row["public_title"];
    const offerType = row["type"] as any;

    if (!internalName || !publicTitle || !offerType) {
      errors.push({ row: i + 1, message: "Missing required fields: internal_name, public_title, type" });
      continue;
    }

    try {
      const [newOffer] = await db.insert(offers).values({
        shopId,
        internalName,
        publicTitle,
        type: offerType,
        status: "draft",
        priority: parseInt(row["priority"] ?? "100", 10) || 100,
        discountTags: row["discount_tags"] ? row["discount_tags"].split("|") : [],
      }).returning({ id: offers.id });

      if (!newOffer) { errors.push({ row: i + 1, message: "Failed to create offer" }); continue; }

      // Create condition if provided
      if (row["condition_type"] && row["condition_value_threshold_cents"]) {
        await db.insert(offerConditions).values({
          shopId,
          offerId: newOffer.id,
          scope: "main",
          conditionType: row["condition_type"],
          operator: "gte",
          value: { thresholdCents: parseInt(row["condition_value_threshold_cents"], 10), currencyCode: "USD", includeGiftValues: false },
          sortOrder: 0,
          isEnabled: true,
        });
      }

      // Create reward if provided
      if (row["reward_type"] && row["discount_type"]) {
        const variantIds = row["gift_variant_gids"] ? row["gift_variant_gids"].split("|").filter(Boolean) : [];
        await db.insert(offerRewards).values({
          shopId,
          offerId: newOffer.id,
          rewardType: row["reward_type"] as any,
          discountType: row["discount_type"] as any,
          value: { amount: parseFloat(row["reward_value"] ?? "0") || 100 },
          target: { variantIds },
          quantity: parseInt(row["gift_quantity"] ?? "1", 10) || 1,
          isAutoAdd: row["is_auto_add"] === "true",
          isCustomerSelectable: false,
          trackMode: (row["track_mode"] as "product" | "variant") ?? "product",
          sortOrder: 0,
          label: null,
        });
      }

      await db.insert(offerCombinationPolicies).values({
        shopId, offerId: newOffer.id,
        combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
        combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true,
        stopLowerPriority: false, giftValueCountsForOtherOffers: false,
      });

      created.push(newOffer.id);
    } catch (e) {
      errors.push({ row: i + 1, message: (e as Error).message });
    }
  }

  return { created, errors, error: null };
};

export default function OffersImportPage() {
  const navigate = useNavigate();
  const actionData = useActionData<typeof action>();
  const [csvText, setCsvText] = useState("");
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);

  function parsePreview(text: string) {
    const lines = text.split("\n").filter((l) => l.trim()).slice(0, 6);
    if (lines.length < 1) return;
    const hdrs = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).map((l) => l.split(",").map((v) => v.trim().replace(/^"|"$/g, "")));
    setHeaders(hdrs);
    setPreviewRows(rows);
  }

  const TEMPLATE_CSV = `internal_name,public_title,type,priority,condition_type,condition_value_threshold_cents,reward_type,discount_type,reward_value,gift_variant_gids,gift_quantity,is_auto_add,track_mode,discount_tags
free-gift-50-usd,Free Gift with $50 Purchase,gift,100,cart_value,5000,product_gift,free,100,gid://shopify/ProductVariant/12345,1,true,product,summer-promo
volume-discount-3plus,Volume Discount Buy 3+,discount,200,cart_quantity,3,order_discount,percentage,10,,,,, `;

  return (
    <Page
      title="Import Offers from CSV"
      backAction={{ content: "All Offers", url: "/app/offers" }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical" title="Import Error">{actionData.error}</Banner>
          </Layout.Section>
        )}

        {actionData && !actionData.error && (
          <Layout.Section>
            <Banner
              tone={actionData.errors.length === 0 ? "success" : "warning"}
              title={`Import complete: ${actionData.created.length} created, ${actionData.errors.length} errors`}
            >
              {actionData.errors.map((e) => (
                <p key={e.row}>Row {e.row}: {e.message}</p>
              ))}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <LegacyCard title="CSV Template" sectioned>
            <Text as="p" tone="subdued">Download the template, fill it in, then upload below.</Text>
            <BlockStack gap="300">
              <Button
                onClick={() => {
                  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = "offer-import-template.csv"; a.click();
                }}
              >
                Download Template CSV
              </Button>
              <Text as="p" variant="bodySm" tone="subdued">
                Required fields: internal_name, public_title, type (gift|bundle|upsell|discount|booster).
                Products are referenced by Shopify variant GID. All created offers start as drafts.
              </Text>
            </BlockStack>
          </LegacyCard>
        </Layout.Section>

        <Layout.Section>
          <LegacyCard title="Upload CSV" sectioned>
            <Form method="POST" encType="multipart/form-data">
              <BlockStack gap="400">
                <textarea
                  name="csvContent"
                  rows={10}
                  style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
                  placeholder="Paste CSV content here or type..."
                  value={csvText}
                  onChange={(e) => {
                    setCsvText(e.target.value);
                    parsePreview(e.target.value);
                  }}
                />

                {previewRows.length > 0 && (
                  <DataTable
                    columnContentTypes={headers.map(() => "text" as const)}
                    headings={headers}
                    rows={previewRows.map((r) => r.map((v) => v || "—"))}
                  />
                )}

                <InlineStack gap="300">
                  <Button variant="primary" submit disabled={!csvText.trim()}>
                    Import {previewRows.length > 0 ? `(${previewRows.length} rows preview)` : ""}
                  </Button>
                  <Button onClick={() => navigate("/app/offers")}>Cancel</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </LegacyCard>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
