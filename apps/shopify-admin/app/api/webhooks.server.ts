/**
 * Centralized webhook dispatcher using Hono.
 * All routes: POST /webhooks/:topic
 * Every handler validates HMAC before processing.
 * Heavy work is enqueued to BullMQ — handlers return 200 immediately.
 */

import { Hono } from "hono";
import { createWebhookHmacMiddleware } from "../lib/hmac.server.js";
import { getDb, shops, productCache, variantCache, analyticsEvents } from "@promo/db";
import { eq, and } from "drizzle-orm";

const SECRET = process.env["SHOPIFY_API_SECRET"] ?? "";
const webhookApp = new Hono();

// Apply HMAC validation to ALL webhook routes
webhookApp.use("*", createWebhookHmacMiddleware(SECRET));

// ── Helper: get shopId from shop domain ───────────────────────────────────────
async function getShopId(shopDomain: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select({ id: shops.id }).from(shops)
    .where(eq(shops.myshopifyDomain, shopDomain)).limit(1);
  return row?.id ?? null;
}

// ── Products ──────────────────────────────────────────────────────────────────

webhookApp.post("/products/update", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  const rawBody = c.get("rawBody") as string;
  const product = JSON.parse(rawBody) as any;

  // Enqueue partial sync for this product
  const { productSyncQueue } = await import("../lib/queues.server.js");
  const [shop] = await getDb().select({ accessTokenEncrypted: shops.accessTokenEncrypted, myshopifyDomain: shops.myshopifyDomain })
    .from(shops).where(eq(shops.id, shopId)).limit(1);

  if (shop) {
    await productSyncQueue.add(`product-update-${product.id}`, {
      shopId,
      shopDomain: shop.myshopifyDomain,
      accessToken: shop.accessTokenEncrypted,
      mode: "partial" as const,
      productGid: product.admin_graphql_api_id,
    }, { priority: 5 });
  }

  return c.text("OK", 200);
});

webhookApp.post("/products/delete", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  const rawBody = c.get("rawBody") as string;
  const { id } = JSON.parse(rawBody) as { id: number };
  const db = getDb();

  await db.update(productCache).set({ status: "ARCHIVED", syncedAt: new Date() })
    .where(and(eq(productCache.shopId, shopId), eq(productCache.legacyProductId, id)));

  return c.text("OK", 200);
});

// ── Inventory ─────────────────────────────────────────────────────────────────

webhookApp.post("/inventory", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  const rawBody = c.get("rawBody") as string;
  const payload = JSON.parse(rawBody) as { inventory_item_id: number; location_id: number; available: number };

  const { inventorySyncQueue } = await import("../lib/queues.server.js") as any;
  const [shop] = await getDb().select({ accessTokenEncrypted: shops.accessTokenEncrypted, myshopifyDomain: shops.myshopifyDomain })
    .from(shops).where(eq(shops.id, shopId)).limit(1);

  if (shop && inventorySyncQueue) {
    await inventorySyncQueue.add(`inv-update-${payload.inventory_item_id}`, {
      shopId,
      shopDomain: shop.myshopifyDomain,
      accessToken: shop.accessTokenEncrypted,
      inventoryItemId: payload.inventory_item_id,
      locationId: payload.location_id,
      availableQuantity: payload.available,
    }, { priority: 3 });
  }

  return c.text("OK", 200);
});

// ── Orders ────────────────────────────────────────────────────────────────────

webhookApp.post("/orders", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const topic = c.req.header("X-Shopify-Topic") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  const rawBody = c.get("rawBody") as string;
  const order = JSON.parse(rawBody) as any;

  if (topic === "orders/paid") {
    // Extract offer attribution from note_attributes
    const offerIds: string[] = [];
    const sessionId = order.note_attributes?.find((a: any) => a.name === "_promo_engine_session_id")?.value ?? null;
    const offerIdsAttr = order.note_attributes?.find((a: any) => a.name === "_promo_engine_offer_ids")?.value;
    if (offerIdsAttr) {
      try { offerIds.push(...JSON.parse(offerIdsAttr)); } catch {}
    }

    // Enqueue attribution reconciliation
    const { analyticsReconcileQueue } = await import("../lib/queues.server.js") as any;
    if (analyticsReconcileQueue) {
      await analyticsReconcileQueue.add(`order-paid-${order.id}`, {
        shopId,
        shopDomain,
        orderId: String(order.id),
        orderGid: order.admin_graphql_api_id,
        cartToken: order.cart_token ?? null,
        totalPriceCents: Math.round(parseFloat(order.total_price ?? "0") * 100),
        offerIds,
        sessionId,
      });
    }
  }

  if (topic === "orders/cancelled") {
    // Mark attribution as reversed
    const db = getDb();
    await db.delete(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.eventName, "order_placed_attributed"),
        eq(analyticsEvents.orderId, order.admin_graphql_api_id),
      ));
  }

  return c.text("OK", 200);
});

// ── Customers ─────────────────────────────────────────────────────────────────

webhookApp.post("/customers", async (c) => {
  // Invalidate customer segment cache in Redis
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  const rawBody = c.get("rawBody") as string;
  const customer = JSON.parse(rawBody) as { id: number; admin_graphql_api_id: string };

  // Invalidate Redis cache for this customer's eligibility data
  try {
    const { redis } = await import("../lib/queues.server.js");
    await redis.del(`customer:${shopId}:${customer.admin_graphql_api_id}`);
  } catch {}

  return c.text("OK", 200);
});

// ── Markets ───────────────────────────────────────────────────────────────────

webhookApp.post("/markets", async (c) => {
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";
  const shopId = await getShopId(shopDomain);
  if (!shopId) return c.text("OK", 200);

  // Invalidate Redis markets cache so next request fetches fresh data
  const { invalidateMarketsCache } = await import("../lib/markets.server.js");
  await invalidateMarketsCache(shopId);

  // Enqueue market sync to update Redis with fresh market data
  const { redis } = await import("../lib/queues.server.js");
  const [shop] = await getDb().select({
    accessTokenEncrypted: shops.accessTokenEncrypted,
    myshopifyDomain: shops.myshopifyDomain,
  }).from(shops).where(eq(shops.id, shopId)).limit(1);

  if (shop) {
    // Warm the cache immediately via background worker
    await redis.publish(`market-sync:${shopId}`, JSON.stringify({
      shopId,
      shopDomain: shop.myshopifyDomain,
      accessToken: shop.accessTokenEncrypted,
    }));
  }

  return c.text("OK", 200);
});

// ── GDPR / App uninstalled ────────────────────────────────────────────────────

webhookApp.post("/gdpr", async (c) => {
  const topic = c.req.header("X-Shopify-Topic") ?? "";
  const shopDomain = c.req.header("X-Shopify-Shop-Domain") ?? "";

  // GDPR mandatory — must respond 200 within 5 seconds
  if (topic === "app/uninstalled") {
    const shopId = await getShopId(shopDomain);
    if (shopId) {
      const db = getDb();
      await db.update(shops).set({ isActive: false, uninstalledAt: new Date() })
        .where(eq(shops.id, shopId));
    }
  }

  // GDPR data requests / redact — log and respond (implement data deletion as needed)
  console.info(`GDPR webhook: ${topic} for ${shopDomain}`);

  return c.text("OK", 200);
});

export { webhookApp };
