/**
 * Keeps variant_cache honest for the variants that decide gift availability (every active gift
 * reward's variants plus its fallbacks). The cache is webhook-fed and was seen drifting (sold-out
 * variants cached as available), so this re-reads Shopify's own availableForSale / inventory.
 */
import { getDb, offerRewards, offers, shops, variantCache } from "@promo/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import { decryptToken } from "../token-crypto.server.js";
import { PRODUCT_VARIANTS_QUERY } from "./product-sync.server.js";

interface LiveVariant {
  id: string;
  title: string;
  inventoryQuantity: number | null;
  inventoryPolicy: string;
  availableForSale: boolean;
  inventoryItem?: { tracked: boolean } | null;
}

const NODES_QUERY = `
  query GiftVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id title inventoryQuantity inventoryPolicy availableForSale
        inventoryItem { tracked }
      }
    }
  }
`;

export interface VariantChange {
  variantGid: string;
  title: string;
  before: { availableForSale: boolean; inventoryQuantity: number | null; inventoryTracked: boolean | null };
  after: { availableForSale: boolean; inventoryQuantity: number | null; inventoryTracked: boolean | null };
}

/** Gift + fallback variant GIDs of the shop's active (or scheduled) gift offers. */
export async function giftVariantIdsForShop(shopId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ target: offerRewards.target })
    .from(offerRewards)
    .innerJoin(offers, eq(offers.id, offerRewards.offerId))
    .where(
      and(
        eq(offerRewards.shopId, shopId),
        eq(offerRewards.rewardType, "product_gift"),
        inArray(offers.status, ["active", "scheduled"]),
      ),
    );
  const ids = new Set<string>();
  for (const { target } of rows) {
    const t = target as { variantId?: string; variantIds?: string[]; fallbackVariantIds?: string[] };
    for (const id of [t.variantId, ...(t.variantIds ?? []), ...(t.fallbackVariantIds ?? [])]) if (id) ids.add(id);
  }
  return [...ids];
}

async function fetchLiveVariants(shopDomain: string, accessToken: string, ids: string[]): Promise<LiveVariant[]> {
  const live: LiveVariant[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await shopifyGraphQL<{ nodes: Array<LiveVariant | null> }>({
      shopDomain,
      accessToken,
      query: NODES_QUERY,
      variables: { ids: ids.slice(i, i + 100) },
    });
    live.push(...data.nodes.filter((node): node is LiveVariant => !!node?.id));
  }
  return live;
}

/** Re-reads live stock for a shop's gift/fallback variants and (unless dryRun) updates the cache. */
export async function reconcileGiftVariants(
  shopId: string,
  options: {
    dryRun?: boolean;
    /** False only for a dry-run against a database that hasn't run the inventory_tracked migration yet. */
    trackedColumn?: boolean;
  } = {},
): Promise<{ checked: number; missing: string[]; changes: VariantChange[] }> {
  const db = getDb();
  const [shop] = await db
    .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.uninstalledAt)))
    .limit(1);
  if (!shop) return { checked: 0, missing: [], changes: [] };

  const ids = await giftVariantIdsForShop(shopId);
  if (ids.length === 0) return { checked: 0, missing: [], changes: [] };

  const live = await fetchLiveVariants(shop.domain, await decryptToken(shop.token), ids);
  const cached = await db
    .select({
      variantGid: variantCache.variantGid,
      title: variantCache.title,
      inventoryQuantity: variantCache.inventoryQuantity,
      inventoryPolicy: variantCache.inventoryPolicy,
      availableForSale: variantCache.availableForSale,
      ...(options.trackedColumn === false ? {} : { inventoryTracked: variantCache.inventoryTracked }),
    })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, ids)));
  const cachedById = new Map(cached.map((row) => [row.variantGid, row]));

  const changes: VariantChange[] = [];
  for (const variant of live) {
    const row = cachedById.get(variant.id);
    if (!row) continue;
    const after = {
      availableForSale: variant.availableForSale,
      inventoryQuantity: variant.inventoryQuantity,
      inventoryTracked: variant.inventoryItem?.tracked ?? null,
    };
    const before = {
      availableForSale: row.availableForSale,
      inventoryQuantity: row.inventoryQuantity,
      inventoryTracked: ("inventoryTracked" in row ? row.inventoryTracked : null) ?? null,
    };
    if (JSON.stringify(before) === JSON.stringify(after) && row.inventoryPolicy === variant.inventoryPolicy) continue;
    changes.push({ variantGid: variant.id, title: row.title, before, after });
    if (options.dryRun) continue;
    await db
      .update(variantCache)
      .set({ ...after, inventoryPolicy: variant.inventoryPolicy, syncedAt: new Date() })
      .where(and(eq(variantCache.shopId, shopId), eq(variantCache.variantGid, variant.id)));
  }
  const liveIds = new Set(live.map((v) => v.id));
  return { checked: live.length, missing: ids.filter((id) => !liveIds.has(id)), changes };
}

/** Cron entry: reconcile every installed shop. */
export async function reconcileAllShopsGiftVariants(): Promise<{ shops: number; changed: number }> {
  const rows = await getDb().select({ id: shops.id }).from(shops).where(isNull(shops.uninstalledAt));
  let changed = 0;
  for (const { id } of rows) {
    try {
      changed += (await reconcileGiftVariants(id)).changes.length;
    } catch (error) {
      console.warn(`[gift-stock-reconcile] shop ${id} failed`, error);
    }
  }
  return { shops: rows.length, changed };
}

/** Product webhooks omit availability and tracking, so after caching a payload ask Shopify. */
export async function refreshProductVariantsFromAdmin(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  productGid: string,
): Promise<void> {
  const db = getDb();
  let cursor: string | null = null;
  do {
    const data: {
      product: { variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: LiveVariant[] } } | null;
    } = await shopifyGraphQL({
      shopDomain,
      accessToken,
      query: PRODUCT_VARIANTS_QUERY,
      variables: { productId: productGid, after: cursor },
    });
    if (!data.product) return;
    for (const variant of data.product.variants.nodes) {
      await db
        .update(variantCache)
        .set({
          inventoryQuantity: variant.inventoryQuantity,
          inventoryPolicy: variant.inventoryPolicy,
          availableForSale: variant.availableForSale,
          inventoryTracked: variant.inventoryItem?.tracked ?? null,
          syncedAt: new Date(),
        })
        .where(and(eq(variantCache.shopId, shopId), eq(variantCache.variantGid, variant.id)));
    }
    const { hasNextPage, endCursor } = data.product.variants.pageInfo;
    cursor = hasNextPage ? endCursor : null;
  } while (cursor);
}
