/**
 * Inventory Sync Worker
 * Updates variant_cache.inventory_quantity when Shopify fires
 * inventory_levels/update webhooks.
 *
 * Also provides a re-sync endpoint for when webhook delivery fails.
 * Uses Shopify Admin API to fetch current inventory levels.
 */

import { Worker, type Job } from "bullmq";
import pino from "pino";
import { getDb, variantCache, shops } from "@promo/db";
import { eq, and } from "drizzle-orm";
import type Redis from "ioredis";

const log = pino({ name: "inventory-sync-worker" });
const SHOPIFY_API_VERSION = "2026-04";

export interface InventorySyncJobData {
  shopId: string;
  shopDomain: string;
  accessToken: string;
  /** For partial sync: specific inventory item ID from webhook. */
  inventoryItemId?: number;
  locationId?: number;
  availableQuantity?: number;
}

const INVENTORY_QUERY = `
  query GetInventory($inventoryItemId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      id
      variant { id inventoryQuantity inventoryPolicy availableForSale }
    }
  }
`;

export function startInventorySyncWorker(redis: Redis) {
  return new Worker<InventorySyncJobData>(
    "inventory-sync",
    async (job: Job<InventorySyncJobData>) => {
      const { shopId, shopDomain, accessToken, inventoryItemId, availableQuantity } = job.data;

      if (inventoryItemId !== undefined && availableQuantity !== undefined) {
        // Webhook partial update — use the webhook payload directly
        log.info({ shopDomain, inventoryItemId, availableQuantity }, "Partial inventory update from webhook");

        const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;

        // Fetch variant GID for this inventory item via Admin API
        const response = await fetch(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({ query: INVENTORY_QUERY, variables: { inventoryItemId: gid } }),
          },
        );

        if (!response.ok) {
          throw new Error(`Inventory API error: ${response.status}`);
        }

        const data = (await response.json()) as {
          data: {
            inventoryItem: {
              variant: {
                id: string;
                inventoryQuantity: number;
                inventoryPolicy: string;
                availableForSale: boolean;
              };
            } | null;
          };
        };

        const variant = data.data?.inventoryItem?.variant;
        if (!variant) {
          log.warn({ shopDomain, inventoryItemId }, "Variant not found for inventory item");
          return;
        }

        const db = getDb();
        await db
          .update(variantCache)
          .set({
            inventoryQuantity: availableQuantity,
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

        log.info({ shopDomain, variantGid: variant.id, availableQuantity }, "Inventory updated");
        return;
      }

      // Full inventory re-sync — fetch all variants with inventory
      log.info({ shopDomain }, "Starting full inventory re-sync");
      const db = getDb();
      let processed = 0;

      // Get all cached variants for this shop and re-fetch their inventory
      const variants = await db
        .select({ variantGid: variantCache.variantGid })
        .from(variantCache)
        .where(eq(variantCache.shopId, shopId))
        .limit(500); // Process in chunks

      for (const v of variants) {
        try {
          const response = await fetch(
            `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              body: JSON.stringify({
                query: `query { productVariant(id: "${v.variantGid}") { id inventoryQuantity inventoryPolicy availableForSale } }`,
              }),
            },
          );

          if (!response.ok) continue;
          const data = (await response.json()) as {
            data: { productVariant: { inventoryQuantity: number; inventoryPolicy: string; availableForSale: boolean } | null };
          };

          const pv = data.data.productVariant;
          if (!pv) continue;

          await db
            .update(variantCache)
            .set({
              inventoryQuantity: pv.inventoryQuantity,
              inventoryPolicy: pv.inventoryPolicy,
              availableForSale: pv.availableForSale,
              syncedAt: new Date(),
            })
            .where(and(eq(variantCache.shopId, shopId), eq(variantCache.variantGid, v.variantGid)));

          processed++;
        } catch {
          // Continue on individual variant error
        }
      }

      log.info({ shopDomain, processed }, "Full inventory re-sync complete");
    },
    { connection: redis, concurrency: 3 },
  );
}
