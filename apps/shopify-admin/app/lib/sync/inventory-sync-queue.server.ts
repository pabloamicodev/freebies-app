/**
 * Work the products/* and inventory_levels/* webhooks must not do inside Shopify's 5 s delivery
 * window. The handler writes a row (one per shop + kind + ref, so a burst of updates for the same
 * inventory item or product coalesces into one refresh) and a background drain, started with
 * `waitUntil` and backed by the catalog-sync cron, calls Shopify once per batch.
 */
import { getDb, catalogRefreshQueue, shops, variantCache, type Db } from "@promo/db";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import { decryptToken } from "../token-crypto.server.js";
import { refreshProductVariantsFromAdmin } from "./gift-stock-reconcile.server.js";

export type CatalogRefreshKind = "inventory_item" | "product";

export const REFRESH_LEASE_MS = 60_000;
export const REFRESH_MAX_ATTEMPTS = 5;
/** Events for one item arriving inside this window share a single Shopify read. */
export const REFRESH_COALESCE_MS = 1_500;
const INVENTORY_BATCH = 50;

export async function enqueueCatalogRefresh(
  shopId: string,
  items: Array<{ kind: CatalogRefreshKind; ref: string }>,
  db: Db = getDb(),
): Promise<void> {
  if (items.length === 0) return;
  await db
    .insert(catalogRefreshQueue)
    .values(items.map((item) => ({ shopId, kind: item.kind, ref: item.ref, requestedAt: new Date() })))
    .onConflictDoUpdate({
      target: [catalogRefreshQueue.shopId, catalogRefreshQueue.kind, catalogRefreshQueue.ref],
      // Re-requested while queued or in flight: bump it so the in-flight claim doesn't swallow the newer event.
      set: { requestedAt: new Date() },
    });
}

type QueueRow = typeof catalogRefreshQueue.$inferSelect;

/** Takes up to `limit` due rows (not leased, or whose lease passed) and leases them. */
export async function claimCatalogRefreshBatch(
  options: { shopId?: string; limit?: number; now?: Date } = {},
  db: Db = getDb(),
): Promise<{ rows: QueueRow[]; claimedAt: Date }> {
  const claimedAt = options.now ?? new Date();
  const rows = await db.transaction(async (tx) => {
    const due = and(
      or(isNull(catalogRefreshQueue.leasedUntil), lt(catalogRefreshQueue.leasedUntil, claimedAt)),
      options.shopId ? eq(catalogRefreshQueue.shopId, options.shopId) : undefined,
    );
    const candidates = await tx
      .select({ id: catalogRefreshQueue.id })
      .from(catalogRefreshQueue)
      .where(due)
      .orderBy(asc(catalogRefreshQueue.requestedAt))
      .limit(options.limit ?? 100)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .update(catalogRefreshQueue)
      .set({
        leasedUntil: new Date(claimedAt.getTime() + REFRESH_LEASE_MS),
        attempts: sql`${catalogRefreshQueue.attempts} + 1`,
      })
      .where(
        inArray(
          catalogRefreshQueue.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning();
  });
  return { rows, claimedAt };
}

/** Deletes finished rows, except ones re-requested after they were claimed (those run again). */
async function completeRows(db: Db, rows: QueueRow[], claimedAt: Date): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  await db
    .delete(catalogRefreshQueue)
    .where(and(inArray(catalogRefreshQueue.id, ids), lte(catalogRefreshQueue.requestedAt, claimedAt)));
  await db
    .update(catalogRefreshQueue)
    .set({ leasedUntil: null, attempts: 0, lastError: null })
    .where(and(inArray(catalogRefreshQueue.id, ids), sql`${catalogRefreshQueue.requestedAt} > ${claimedAt.toISOString()}::timestamptz`));
}

async function failRows(db: Db, rows: QueueRow[], error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  for (const row of rows) {
    if (row.attempts >= REFRESH_MAX_ATTEMPTS) {
      Sentry.captureException(error, { tags: { context: "catalog-refresh-dropped", kind: row.kind, shopId: row.shopId } });
      await db.delete(catalogRefreshQueue).where(eq(catalogRefreshQueue.id, row.id));
      continue;
    }
    await db
      .update(catalogRefreshQueue)
      .set({
        // Exponential backoff via the lease: 30 s, 60 s, 120 s ...
        leasedUntil: new Date(Date.now() + 30_000 * 2 ** Math.max(0, row.attempts - 1)),
        lastError: message,
      })
      .where(eq(catalogRefreshQueue.id, row.id));
  }
}

interface InventoryItemNode {
  id: string;
  tracked: boolean;
  variants: {
    nodes: Array<{
      id: string;
      inventoryQuantity: number | null;
      inventoryPolicy: string;
      availableForSale: boolean;
    }>;
  };
}

/** One batched read for many inventory items; an InventoryItem has a single variant, so `first: 5` is generous. */
export async function loadInventoryItemsBatch(
  shopDomain: string,
  accessToken: string,
  inventoryItemGids: string[],
  graphQL: typeof shopifyGraphQL = shopifyGraphQL,
): Promise<InventoryItemNode[]> {
  const data = await graphQL<{ nodes: Array<InventoryItemNode | null> }>({
    shopDomain,
    accessToken,
    query: `query PromoEngineInventoryItems($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          tracked
          variants(first: 5) { nodes { id inventoryQuantity inventoryPolicy availableForSale } }
        }
      }
    }`,
    variables: { ids: inventoryItemGids },
  });
  return data.nodes.filter((node): node is InventoryItemNode => Boolean(node?.id));
}

async function refreshInventoryItems(
  db: Db,
  shop: { id: string; domain: string; accessToken: string },
  rows: QueueRow[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += INVENTORY_BATCH) {
    const batch = rows.slice(offset, offset + INVENTORY_BATCH);
    const items = await loadInventoryItemsBatch(
      shop.domain,
      shop.accessToken,
      batch.map((row) => row.ref),
    );
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const item of items) {
        for (const variant of item.variants.nodes) {
          await tx
            .update(variantCache)
            .set({
              // The webhook's `available` is one location's number; the variant's total across
              // locations is the right cache value.
              inventoryQuantity: variant.inventoryQuantity,
              inventoryPolicy: variant.inventoryPolicy,
              availableForSale: variant.availableForSale,
              inventoryTracked: item.tracked,
              syncedAt: now,
            })
            .where(and(eq(variantCache.shopId, shop.id), eq(variantCache.variantGid, variant.id)));
        }
      }
    });
  }
}

export interface DrainResult {
  claimed: number;
  completed: number;
  failed: number;
}

/**
 * Processes due rows: inventory items in batched reads, products one by one. A row that fails is
 * leased out with backoff and retried (dropped with a Sentry alert after REFRESH_MAX_ATTEMPTS).
 */
export async function drainCatalogRefreshQueue(
  options: { shopId?: string; limit?: number; maxRuntimeMs?: number } = {},
  db: Db = getDb(),
): Promise<DrainResult> {
  const deadline = Date.now() + (options.maxRuntimeMs ?? 40_000);
  const result: DrainResult = { claimed: 0, completed: 0, failed: 0 };
  while (Date.now() < deadline) {
    const { rows, claimedAt } = await claimCatalogRefreshBatch(
      { ...(options.shopId ? { shopId: options.shopId } : {}), limit: options.limit ?? 100 },
      db,
    );
    if (rows.length === 0) break;
    result.claimed += rows.length;

    const byShop = new Map<string, QueueRow[]>();
    for (const row of rows) byShop.set(row.shopId, [...(byShop.get(row.shopId) ?? []), row]);
    for (const [shopId, shopRows] of byShop) {
      const [shop] = await db
        .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted, isActive: shops.isActive })
        .from(shops)
        .where(eq(shops.id, shopId))
        .limit(1);
      if (!shop?.isActive) {
        await completeRows(db, shopRows, claimedAt);
        continue;
      }
      const context = { id: shopId, domain: shop.domain, accessToken: await decryptToken(shop.token) };
      const inventory = shopRows.filter((row) => row.kind === "inventory_item");
      const products = shopRows.filter((row) => row.kind === "product");
      try {
        await refreshInventoryItems(db, context, inventory);
        await completeRows(db, inventory, claimedAt);
        result.completed += inventory.length;
      } catch (error) {
        await failRows(db, inventory, error);
        result.failed += inventory.length;
      }
      for (const row of products) {
        try {
          await refreshProductVariantsFromAdmin(shopId, context.domain, context.accessToken, row.ref);
          await completeRows(db, [row], claimedAt);
          result.completed += 1;
        } catch (error) {
          await failRows(db, [row], error);
          result.failed += 1;
        }
      }
    }
    if (rows.length < (options.limit ?? 100)) break;
  }
  return result;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a webhook hands to `waitUntil`: wait a moment so a burst coalesces, then drain this shop. */
export async function coalescedDrain(shopId: string, delayMs: number = REFRESH_COALESCE_MS): Promise<DrainResult> {
  await sleep(delayMs);
  return drainCatalogRefreshQueue({ shopId, maxRuntimeMs: 45_000 });
}
