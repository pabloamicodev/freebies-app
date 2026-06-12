/**
 * Collection Sync Worker
 * Syncs product-to-collection membership so the rule engine can
 * evaluate collection-based conditions (e.g., "product must be in collection X").
 *
 * Populates: product_cache.collections[] with collection GIDs.
 * Triggered: on app install, collection webhooks, and periodic refresh.
 */

import { Worker, type Job } from "bullmq";
import pino from "pino";
import { getDb, productCache } from "@promo/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import type Redis from "ioredis";

const log = pino({ name: "collection-sync-worker" });
const SHOPIFY_API_VERSION = "2026-04";

export interface CollectionSyncJobData {
  shopId: string;
  shopDomain: string;
  accessToken: string;
  /** Specific collection GID for partial sync. */
  collectionGid?: string;
}

const COLLECTION_PRODUCTS_QUERY = `
  query GetCollectionProducts($collectionId: ID!, $after: String) {
    collection(id: $collectionId) {
      id
      products(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const ALL_COLLECTIONS_QUERY = `
  query GetCollections($after: String) {
    collections(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id title handle }
    }
  }
`;

export function startCollectionSyncWorker(redis: Redis) {
  return new Worker<CollectionSyncJobData>(
    "collection-sync",
    async (job: Job<CollectionSyncJobData>) => {
      const { shopId, shopDomain, accessToken, collectionGid } = job.data;
      const db = getDb();

      if (collectionGid) {
        // Partial sync: sync just this collection's products
        await syncCollectionProducts(shopDomain, accessToken, shopId, collectionGid, db);
        return;
      }

      // Full sync: iterate all collections
      log.info({ shopDomain }, "Starting full collection membership sync");
      let cursor: string | null = null;
      let synced = 0;

      do {
        const res = await fetch(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({ query: ALL_COLLECTIONS_QUERY, variables: { after: cursor } }),
          },
        );

        const data = (await res.json()) as {
          data: { collections: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> } };
        };

        const { nodes, pageInfo } = data.data.collections;

        for (const col of nodes) {
          await syncCollectionProducts(shopDomain, accessToken, shopId, col.id, db);
          synced++;
        }

        cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      } while (cursor);

      log.info({ shopDomain, synced }, "Collection sync complete");
    },
    { connection: redis, concurrency: 2 },
  );
}

async function syncCollectionProducts(
  shopDomain: string,
  accessToken: string,
  shopId: string,
  collectionGid: string,
  db: ReturnType<typeof getDb>,
) {
  let cursor: string | null = null;

  do {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({
          query: COLLECTION_PRODUCTS_QUERY,
          variables: { collectionId: collectionGid, after: cursor },
        }),
      },
    );

    const data = (await res.json()) as {
      data: {
        collection: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string }>;
          };
        } | null;
      };
    };

    const collection = data.data.collection;
    if (!collection) break;

    const productGids = collection.products.nodes.map((p) => p.id);
    if (productGids.length === 0) {
      cursor = collection.products.pageInfo.hasNextPage
        ? collection.products.pageInfo.endCursor
        : null;
      continue;
    }

    // Single UPDATE: append collectionGid to all products in this page that don't have it yet.
    // Replaces the previous per-row SELECT + UPDATE loop (N+1 → 1 query).
    await db
      .update(productCache)
      .set({
        collections: sql`array_append(${productCache.collections}, ${collectionGid}::text)`,
        syncedAt: new Date(),
      })
      .where(
        and(
          eq(productCache.shopId, shopId),
          inArray(productCache.productGid, productGids),
          sql`NOT (${collectionGid}::text = ANY(${productCache.collections}))`,
        ),
      );

    cursor = collection.products.pageInfo.hasNextPage
      ? collection.products.pageInfo.endCursor
      : null;
  } while (cursor);
}
