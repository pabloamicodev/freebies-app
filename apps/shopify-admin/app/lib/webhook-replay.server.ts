/**
 * Webhook Replay — re-process failed or missed webhooks.
 * Useful when:
 * - Shopify webhook delivery failed during downtime
 * - Inventory sync missed an update
 * - Manual re-sync needed for a specific resource
 */

import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

const SHOPIFY_API_VERSION = "2026-04";

export type ReplayTopic =
  | "products/update"
  | "inventory_levels/update"
  | "orders/paid"
  | "customers/update";

/** Trigger a full re-sync for a specific topic by re-fetching from Shopify Admin API. */
export async function replayWebhookTopic(
  shopId: string,
  topic: ReplayTopic,
): Promise<{ queued: number }> {
  const db = getDb();
  const shopRows = await db
    .select({ myshopifyDomain: shops.myshopifyDomain, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return { queued: 0 };

  // Import the queue dynamically to avoid circular dependencies
  const { productSyncQueue, inventorySyncQueue } = await import(
    "../../workers/product-sync/src/queues.js"
  );

  switch (topic) {
    case "products/update":
      await productSyncQueue.add("replay-products", {
        shopId,
        shopDomain: shop.myshopifyDomain,
        accessToken: shop.accessTokenEncrypted,
        mode: "full",
      }, { priority: 10 });
      return { queued: 1 };

    case "inventory_levels/update":
      await inventorySyncQueue.add("replay-inventory", {
        shopId,
        shopDomain: shop.myshopifyDomain,
        accessToken: shop.accessTokenEncrypted,
      }, { priority: 10 });
      return { queued: 1 };

    default:
      return { queued: 0 };
  }
}

/** Re-sync a specific product by GID. */
export async function replayProductSync(shopId: string, productGid: string): Promise<void> {
  const db = getDb();
  const shopRows = await db
    .select({ myshopifyDomain: shops.myshopifyDomain, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) return;

  const { productSyncQueue } = await import("../../workers/product-sync/src/queues.js");
  await productSyncQueue.add("replay-single-product", {
    shopId,
    shopDomain: shop.myshopifyDomain,
    accessToken: shop.accessTokenEncrypted,
    mode: "partial",
    productGid,
  }, { priority: 5 });
}
