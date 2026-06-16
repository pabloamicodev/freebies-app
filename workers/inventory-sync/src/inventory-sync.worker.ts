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
import { SHOPIFY_API_VERSION } from "@promo/shared-types";

const log = pino({ name: "inventory-sync-worker" });

async function decryptAccessToken(stored: string): Promise<string> {
  const sep = stored.indexOf(":");
  if (sep === -1) return stored;
  const keyHex = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!keyHex) return stored;
  try {
    const key = await crypto.subtle.importKey("raw", Buffer.from(keyHex, "hex"), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(stored.slice(0, sep), "hex") }, key, Buffer.from(stored.slice(sep + 1), "hex"));
    return new TextDecoder().decode(plaintext);
  } catch { return stored; }
}

export interface InventorySyncJobData {
  shopId: string;
  shopDomain: string;
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
  const worker = new Worker<InventorySyncJobData>(
    "inventory-sync",
    async (job: Job<InventorySyncJobData>) => {
      const { shopId, shopDomain, inventoryItemId, availableQuantity } = job.data;
      const db = getDb();
      const shopRow = await db.select({ accessTokenEncrypted: shops.accessTokenEncrypted })
        .from(shops).where(eq(shops.id, shopId)).limit(1).then((r) => r[0]);
      if (!shopRow) throw new Error(`Shop ${shopId} not found`);
      const accessToken = await decryptAccessToken(shopRow.accessTokenEncrypted);

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
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!response.ok) {
          throw new Error(`Inventory API error: ${response.status}`);
        }

        const data = (await response.json()) as {
          data?: {
            inventoryItem: {
              variant: {
                id: string;
                inventoryQuantity: number;
                inventoryPolicy: string;
                availableForSale: boolean;
              };
            } | null;
          };
          errors?: unknown[];
        };

        if (data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);
        const variant = data.data?.inventoryItem?.variant;
        if (!variant) {
          log.warn({ shopDomain, inventoryItemId }, "Variant not found for inventory item");
          return;
        }

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

      // Full inventory re-sync — cursor-paginate through ALL cached variants.
      // Previously used LIMIT 500 which silently skipped variants beyond page 1.
      log.info({ shopDomain }, "Starting full inventory re-sync");
      let processed = 0;
      const PAGE_SIZE = 250;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const variants = await db
          .select({ variantGid: variantCache.variantGid })
          .from(variantCache)
          .where(eq(variantCache.shopId, shopId))
          .limit(PAGE_SIZE)
          .offset(offset);

        if (variants.length === 0) break;
        hasMore = variants.length === PAGE_SIZE;
        offset += variants.length;

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
                  query: `query GetVariant($id: ID!) { productVariant(id: $id) { id inventoryQuantity inventoryPolicy availableForSale } }`,
                  variables: { id: v.variantGid },
                }),
                signal: AbortSignal.timeout(10_000),
              },
            );

            if (!response.ok) continue;
            const data = (await response.json()) as {
              data?: { productVariant: { inventoryQuantity: number; inventoryPolicy: string; availableForSale: boolean } | null };
              errors?: unknown[];
            };

            if (data.errors?.length) continue;
            const pv = data.data?.productVariant;
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
            // Continue on individual variant error so one bad variant doesn't abort the full sync
          }
        }

        await job.updateProgress(Math.round((processed / Math.max(offset, 1)) * 100));
      }

      log.info({ shopDomain, processed }, "Full inventory re-sync complete");
    },
    { connection: redis, concurrency: 3, lockDuration: 120_000 },
  );

  worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.id, shopDomain: job?.data.shopDomain, inventoryItemId: job?.data.inventoryItemId, err: err.message },
      "inventory-sync job failed permanently",
    );
  });

  return worker;
}
