import { getDb, variantCache } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { SHOPIFY_API_VERSION } from "@promo/shared-types";

export async function syncInventoryFromWebhook(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  inventoryItemId: number,
  availableQuantity: number,
): Promise<void> {
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;

  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({
        query: `query GetInventory($id: ID!) { inventoryItem(id: $id) { variant { id inventoryQuantity inventoryPolicy availableForSale } } }`,
        variables: { id: gid },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) throw new Error(`Inventory API error: ${response.status}`);

  const data = (await response.json()) as {
    data?: { inventoryItem: { variant: { id: string; inventoryQuantity: number; inventoryPolicy: string; availableForSale: boolean } | null } | null };
    errors?: unknown[];
  };

  if (data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);
  const variant = data.data?.inventoryItem?.variant;
  if (!variant) return;

  const db = getDb();
  await db
    .update(variantCache)
    .set({
      inventoryQuantity: availableQuantity,
      inventoryPolicy: variant.inventoryPolicy,
      availableForSale: variant.availableForSale,
      syncedAt: new Date(),
    })
    .where(and(eq(variantCache.shopId, shopId), eq(variantCache.variantGid, variant.id)));
}
