/**
 * Keeps variant_cache honest. The cache is webhook-fed and was seen drifting (sold-out variants
 * cached as available), so this re-reads Shopify's own availableForSale / inventory for the
 * variants that decide gift availability (every active gift reward's variants plus fallbacks),
 * or, with scope "all", for every cached variant of a shop.
 */
import { getDb, offerRewards, offers, shops, variantCache } from "@promo/db";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
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

/** Shopify's `nodes` accepts up to 250 ids; stay well under to keep query cost low. */
export const RECONCILE_BATCH_SIZE = 100;

type Db = ReturnType<typeof getDb>;
type GraphQL = typeof shopifyGraphQL;

interface StockSnapshot {
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryTracked: boolean | null;
}

export interface VariantChange {
  variantGid: string;
  title: string;
  before: StockSnapshot;
  after: StockSnapshot;
}

export interface ReconcileResult {
  checked: number;
  /** Cached variants Shopify no longer returns. */
  missing: number;
  changed: number;
  /** Subset of `changed` where availability, quantity or policy differ (not just the tracked flag). */
  stockChanged: number;
  /** First `sampleLimit` changes (all of them when no limit is given). */
  sample: VariantChange[];
}

export interface ReconcileOptions {
  dryRun?: boolean;
  /** "gift" (default): gift + fallback variants of active offers; "all": every cached variant. */
  scope?: "gift" | "all";
  sampleLimit?: number;
  /** False only for a dry-run against a database that hasn't run the inventory_tracked migration yet. */
  trackedColumn?: boolean;
  graphQL?: GraphQL;
}

interface CachedRow {
  variantGid: string;
  title: string;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  availableForSale: boolean;
  inventoryTracked?: boolean | null;
}

/** Gift + fallback variant GIDs of the shop's active (or scheduled) gift offers. */
export async function giftVariantIdsForShop(shopId: string, db: Db = getDb()): Promise<string[]> {
  const rows = await db
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

function cachedColumns(trackedColumn: boolean | undefined) {
  return {
    variantGid: variantCache.variantGid,
    title: variantCache.title,
    inventoryQuantity: variantCache.inventoryQuantity,
    inventoryPolicy: variantCache.inventoryPolicy,
    availableForSale: variantCache.availableForSale,
    ...(trackedColumn === false ? {} : { inventoryTracked: variantCache.inventoryTracked }),
  };
}

/** Core: compares cached rows with Shopify's live values (batched), updating unless dryRun. */
export async function reconcileRows(
  db: Db,
  shop: { id: string; domain: string; accessToken: string },
  rows: CachedRow[],
  options: ReconcileOptions,
  totals: ReconcileResult,
): Promise<void> {
  const graphQL = options.graphQL ?? shopifyGraphQL;
  for (let i = 0; i < rows.length; i += RECONCILE_BATCH_SIZE) {
    const batch = rows.slice(i, i + RECONCILE_BATCH_SIZE);
    const data = await graphQL<{ nodes: Array<LiveVariant | null> }>({
      shopDomain: shop.domain,
      accessToken: shop.accessToken,
      query: NODES_QUERY,
      variables: { ids: batch.map((row) => row.variantGid) },
    });
    const live = new Map(data.nodes.filter((node): node is LiveVariant => !!node?.id).map((node) => [node.id, node]));
    for (const row of batch) {
      const variant = live.get(row.variantGid);
      if (!variant) {
        totals.missing++;
        continue;
      }
      totals.checked++;
      const after: StockSnapshot = {
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity,
        inventoryTracked: variant.inventoryItem?.tracked ?? null,
      };
      const before: StockSnapshot = {
        availableForSale: row.availableForSale,
        inventoryQuantity: row.inventoryQuantity,
        inventoryTracked: row.inventoryTracked ?? null,
      };
      if (JSON.stringify(before) === JSON.stringify(after) && row.inventoryPolicy === variant.inventoryPolicy) continue;
      totals.changed++;
      if (
        before.availableForSale !== after.availableForSale ||
        before.inventoryQuantity !== after.inventoryQuantity ||
        row.inventoryPolicy !== variant.inventoryPolicy
      ) {
        totals.stockChanged++;
        // Tracked-flag-only differences are bookkeeping noise; samples show real stock drift.
        if (options.sampleLimit === undefined || totals.sample.length < options.sampleLimit) {
          totals.sample.push({ variantGid: row.variantGid, title: row.title, before, after });
        }
      }
      if (options.dryRun) continue;
      await db
        .update(variantCache)
        .set({ ...after, inventoryPolicy: variant.inventoryPolicy, syncedAt: new Date() })
        .where(and(eq(variantCache.shopId, shop.id), eq(variantCache.variantGid, row.variantGid)));
    }
  }
}

/** Re-reads live stock for a shop's cached variants and (unless dryRun) updates the cache. Idempotent. */
export async function reconcileShopVariants(shopId: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const db = getDb();
  const totals: ReconcileResult = { checked: 0, missing: 0, changed: 0, stockChanged: 0, sample: [] };
  const [row] = await db
    .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.uninstalledAt)))
    .limit(1);
  if (!row) return totals;
  const shop = { id: shopId, domain: row.domain, accessToken: await decryptToken(row.token) };
  const columns = cachedColumns(options.trackedColumn);

  if (options.scope === "all") {
    // Keyset pagination keeps memory flat on large catalogs and survives concurrent updates.
    let after = "";
    for (;;) {
      const page: CachedRow[] = await db
        .select(columns)
        .from(variantCache)
        .where(and(eq(variantCache.shopId, shopId), gt(variantCache.variantGid, after)))
        .orderBy(asc(variantCache.variantGid))
        .limit(RECONCILE_BATCH_SIZE * 5);
      if (page.length === 0) break;
      await reconcileRows(db, shop, page, options, totals);
      after = page[page.length - 1]!.variantGid;
    }
    return totals;
  }

  const ids = await giftVariantIdsForShop(shopId, db);
  if (ids.length === 0) return totals;
  const cached: CachedRow[] = await db
    .select(columns)
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, ids)));
  await reconcileRows(db, shop, cached, options, totals);
  return totals;
}

/** Gift/fallback variants of one shop (what the cron runs). */
export const reconcileGiftVariants = (shopId: string, options: Omit<ReconcileOptions, "scope"> = {}) =>
  reconcileShopVariants(shopId, { ...options, scope: "gift" });

/** Cron entry: reconcile every installed shop; one shop failing never stops the others. */
export async function reconcileAllShopsGiftVariants(
  options: ReconcileOptions = {},
): Promise<{ shops: number; changed: number; failed: number }> {
  const rows = await getDb().select({ id: shops.id }).from(shops).where(isNull(shops.uninstalledAt));
  let changed = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      changed += (await reconcileGiftVariants(id, options)).changed;
    } catch (error) {
      failed++;
      console.warn(`[gift-stock-reconcile] shop ${id} failed`, error);
    }
  }
  return { shops: rows.length, changed, failed };
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
