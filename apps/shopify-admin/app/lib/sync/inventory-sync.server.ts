import { getDb, variantCache, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { shopifyGraphQL } from "../shopify-fetch.server.js";

interface InventoryVariant {
  id: string;
  inventoryQuantity: number | null;
  inventoryPolicy: string;
  availableForSale: boolean;
}

interface InventoryVariantPage {
  inventoryItem: {
    variants: {
      nodes: InventoryVariant[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

export const INVENTORY_VARIANTS_QUERY = `
  query GetInventory($id: ID!, $after: String) {
    inventoryItem(id: $id) {
      variants(first: 250, after: $after) {
        nodes { id inventoryQuantity inventoryPolicy availableForSale }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

type InventoryGraphQL = typeof shopifyGraphQL<InventoryVariantPage>;

export async function loadInventoryVariants(
  shopDomain: string,
  accessToken: string,
  inventoryItemGid: string,
  graphQL: InventoryGraphQL = shopifyGraphQL,
): Promise<InventoryVariant[]> {
  const variants: InventoryVariant[] = [];
  let cursor: string | null = null;

  do {
    const data: InventoryVariantPage = await graphQL({
      shopDomain,
      accessToken,
      query: INVENTORY_VARIANTS_QUERY,
      variables: { id: inventoryItemGid, after: cursor },
    });
    if (!data.inventoryItem) return variants;
    variants.push(...data.inventoryItem.variants.nodes);
    const { hasNextPage, endCursor } = data.inventoryItem.variants.pageInfo;
    if (hasNextPage && !endCursor) {
      throw new Error(`Inventory variants pagination omitted endCursor for ${inventoryItemGid}`);
    }
    cursor = hasNextPage ? endCursor : null;
  } while (cursor);

  return variants;
}

export async function syncInventoryFromWebhook(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  inventoryItemId: number,
  db: Db = getDb(),
): Promise<void> {
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  const variants = await loadInventoryVariants(shopDomain, accessToken, gid);
  if (variants.length === 0) return;

  await db.transaction(async (tx) => {
    for (const variant of variants) {
      await tx
        .update(variantCache)
        .set({
          // The webhook's `available` is one location's quantity; the variant's
          // total inventoryQuantity (already fetched above, across all locations)
          // is the correct cache value — using the per-location number here
          // undercounted stock for any variant tracked at multiple locations.
          inventoryQuantity: variant.inventoryQuantity,
          inventoryPolicy: variant.inventoryPolicy,
          availableForSale: variant.availableForSale,
          syncedAt: new Date(),
        })
        .where(
          and(
            eq(variantCache.shopId, shopId),
            eq(variantCache.variantGid, variant.id),
          ),
        );
    }
  });
}
