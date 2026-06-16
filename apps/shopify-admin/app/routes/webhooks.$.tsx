import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache, shops, analyticsEvents, cartMutationLogs, auditLogs } from "@promo/db";
import { eq, and, inArray } from "drizzle-orm";

/**
 * Central webhook handler for all Shopify webhooks.
 * Each webhook topic is routed to its handler below.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  // Each handler is wrapped: a thrown error (e.g. transient DB failure) must NOT
  // surface as a 500, or Shopify retries the delivery indefinitely. We log and
  // ack with 200 — the next webhook or scheduled sync reconciles any drift.
  try {
    switch (topic) {
      case "PRODUCTS_UPDATE":
      case "PRODUCTS_CREATE":
        await handleProductUpdate(shop, payload as ProductWebhookPayload);
        break;

      case "PRODUCTS_DELETE":
        await handleProductDelete(shop, (payload as { id: number }).id);
        break;

      case "INVENTORY_LEVELS_UPDATE":
      case "INVENTORY_LEVELS_CONNECT":
        await handleInventoryUpdate(shop, payload as InventoryWebhookPayload);
        break;

      case "COLLECTIONS_UPDATE":
      case "COLLECTIONS_CREATE":
        await handleCollectionChange(shop, (payload as { id: number }).id);
        break;

      case "MARKETS_CREATE":
      case "MARKETS_UPDATE":
      case "MARKETS_DELETE":
        await handleMarketChange(shop);
        break;

      case "ORDERS_PAID":
        await handleOrderPaid(shop, payload as OrderWebhookPayload);
        break;

      case "ORDERS_CANCELLED":
        await handleOrderCancelled(shop, payload as OrderWebhookPayload);
        break;

      case "CUSTOMERS_UPDATE":
        await handleCustomersUpdate(shop, payload as CustomerGdprPayload);
        break;

      case "APP_UNINSTALLED":
        await handleAppUninstalled(shop);
        break;

      case "CUSTOMERS_DATA_REQUEST":
        await handleCustomersDataRequest(shop, payload as CustomerGdprPayload);
        break;

      case "CUSTOMERS_REDACT":
        await handleCustomersRedact(shop, payload as CustomerGdprPayload);
        break;

      case "SHOP_REDACT":
        await handleShopRedact(shop);
        break;

      default:
        console.warn(`Unhandled webhook topic: ${topic}`);
    }
  } catch (err) {
    console.error(`Webhook handler failed: topic=${topic} shop=${shop}`, err instanceof Error ? err.message : err);
  }

  return new Response("OK", { status: 200 });
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

interface ProductWebhookPayload {
  id: number;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  tags: string;
  status: string;
  admin_graphql_api_id: string;
  variants?: Array<{
    id: number;
    admin_graphql_api_id: string;
    sku: string;
    title: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity: number;
    inventory_policy: string;
    available: boolean;
    requires_selling_plan: boolean;
  }>;
  images?: Array<{ src: string }>;
}

interface InventoryWebhookPayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
}

interface OrderWebhookPayload {
  id: number;
  admin_graphql_api_id: string;
  cart_token: string | null;
  total_price?: string;
  total_price_set?: { shop_money?: { amount?: string } };
  line_items: Array<{
    id: number;
    variant_id: number;
    product_id: number;
    properties: Array<{ name: string; value: string }>;
  }>;
  note_attributes: Array<{ name: string; value: string }>;
}

async function getShopForWebhook(shopDomain: string) {
  const db = getDb();
  const rows = await db
    .select({ id: shops.id, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.myshopifyDomain, shopDomain))
    .limit(1);
  return rows[0] ?? null;
}

interface CustomerGdprPayload {
  customer?: {
    id?: number | string;
    email?: string;
    phone?: string;
  };
  orders_requested?: Array<{ id: number; name: string }>;
}

async function getShopId(shopDomain: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, shopDomain))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function handleProductUpdate(shop: string, product: ProductWebhookPayload) {
  const shopId = await getShopId(shop);
  if (!shopId) return;

  const db = getDb();
  const productGid = product.admin_graphql_api_id;
  const imageUrl = product.images?.[0]?.src ?? null;

  await db
    .insert(productCache)
    .values({
      shopId,
      productGid,
      legacyProductId: product.id,
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.product_type,
      tags: product.tags ? product.tags.split(",").map((t) => t.trim()) : [],
      status: (product.status ?? "ACTIVE").toUpperCase(),
      imageUrl,
      raw: product as unknown,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [productCache.shopId, productCache.productGid],
      set: {
        handle: product.handle,
        title: product.title,
        vendor: product.vendor,
        productType: product.product_type,
        tags: product.tags ? product.tags.split(",").map((t) => t.trim()) : [],
        status: (product.status ?? "ACTIVE").toUpperCase(),
        imageUrl,
        raw: product as unknown,
        syncedAt: new Date(),
      },
    });

  // Sync variants — single batch upsert instead of N parallel inserts
  if (product.variants && product.variants.length > 0) {
    const now = new Date();
    await db
      .insert(variantCache)
      .values(product.variants.map((variant) => ({
        shopId,
        productGid,
        variantGid: variant.admin_graphql_api_id,
        legacyVariantId: variant.id,
        sku: variant.sku || null,
        title: variant.title,
        price: variant.price,
        compareAtPrice: variant.compare_at_price,
        currencyCode: "USD",
        inventoryQuantity: variant.inventory_quantity,
        inventoryPolicy: (variant.inventory_policy ?? "DENY").toUpperCase(),
        availableForSale: variant.available,
        requiresSellingPlan: variant.requires_selling_plan,
        raw: variant as unknown,
        syncedAt: now,
      })))
      .onConflictDoUpdate({
        target: [variantCache.shopId, variantCache.variantGid],
        set: {
          sku: sql`excluded.sku`,
          title: sql`excluded.title`,
          price: sql`excluded.price`,
          compareAtPrice: sql`excluded.compare_at_price`,
          inventoryQuantity: sql`excluded.inventory_quantity`,
          inventoryPolicy: sql`excluded.inventory_policy`,
          availableForSale: sql`excluded.available_for_sale`,
          raw: sql`excluded.raw`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
}

async function handleProductDelete(shop: string, legacyProductId: number) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const db = getDb();
  const productRows = await db
    .update(productCache)
    .set({ status: "ARCHIVED", syncedAt: new Date() })
    .where(and(eq(productCache.shopId, shopId), eq(productCache.legacyProductId, legacyProductId)))
    .returning({ productGid: productCache.productGid });

  const productGid = productRows[0]?.productGid;
  if (!productGid) return;

  await db
    .delete(variantCache)
    .where(and(eq(variantCache.shopId, shopId), eq(variantCache.productGid, productGid)));
}

async function handleInventoryUpdate(_shop: string, _payload: InventoryWebhookPayload) {
  const shopRecord = await getShopForWebhook(_shop);
  if (!shopRecord) return;
  try {
    const { inventorySyncQueue } = await import("../lib/queues.server.js");
    await inventorySyncQueue.add("inventory-webhook", {
      shopId: shopRecord.id,
      shopDomain: _shop,
      inventoryItemId: _payload.inventory_item_id,
      locationId: _payload.location_id,
      availableQuantity: _payload.available,
    }, { priority: 1, attempts: 3, backoff: { type: "exponential", delay: 1000 } });
  } catch (err) {
    console.warn("Inventory webhook queue unavailable", err instanceof Error ? err.message : err);
  }
}

async function handleMarketChange(shop: string) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  try {
    const { marketSyncQueue } = await import("../lib/queues.server.js");
    await marketSyncQueue.add("market-webhook", { shopId, shopDomain: shop }, { priority: 1 });
  } catch (err) {
    console.warn("Market sync queue unavailable", err instanceof Error ? err.message : err);
  }
}

async function handleCollectionChange(shop: string, legacyCollectionId: number) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const collectionGid = `gid://shopify/Collection/${legacyCollectionId}`;
  try {
    const { collectionSyncQueue } = await import("../lib/queues.server.js");
    await collectionSyncQueue.add("collection-webhook", { shopId, shopDomain: shop, collectionGid }, { priority: 1 });
  } catch (err) {
    console.warn("Collection sync queue unavailable", err instanceof Error ? err.message : err);
  }
}

async function handleOrderPaid(shop: string, order: OrderWebhookPayload) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const offerIds = order.note_attributes
    ?.filter((attr) => attr.name === "_promo_engine_offer_id" || attr.name === "promo_engine_offer_id")
    .map((attr) => attr.value)
    .filter(Boolean) ?? [];
  const sessionId = order.note_attributes
    ?.find((attr) => attr.name === "_promo_engine_session_id" || attr.name === "promo_engine_session_id")
    ?.value ?? null;
  const amount = Number.parseFloat(order.total_price_set?.shop_money?.amount ?? order.total_price ?? "0");
  const totalPriceCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;

  try {
    const { analyticsReconcileQueue } = await import("../lib/queues.server.js");
    await analyticsReconcileQueue.add("order-paid", {
      shopId,
      shopDomain: shop,
      orderId: String(order.id),
      orderGid: order.admin_graphql_api_id,
      cartToken: order.cart_token,
      totalPriceCents,
      offerIds,
      sessionId,
    }, { priority: 2, attempts: 3, backoff: { type: "exponential", delay: 1000 } });
  } catch (err) {
    console.warn("Analytics reconcile queue unavailable", err instanceof Error ? err.message : err);
  }
}

async function handleOrderCancelled(shop: string, order: OrderWebhookPayload) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const db = getDb();
  await db.insert(analyticsEvents).values({
    shopId,
    eventName: "order_cancelled",
    sessionId: order.cart_token,
    cartToken: order.cart_token,
    orderId: order.admin_graphql_api_id,
    properties: {
      order_id: order.id,
    },
  });
}

async function handleAppUninstalled(shop: string) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const db = getDb();
  await db
    .update(shops)
    .set({ isActive: false, uninstalledAt: new Date() })
    .where(eq(shops.myshopifyDomain, shop));
  // Enqueue cleanup job: archive clone products, remove Function configs
}

async function handleCustomersUpdate(shop: string, payload: CustomerGdprPayload) {
  const customerId = String(payload.customer?.id ?? "");
  if (!customerId) return;
  try {
    const { redis } = await import("../lib/queues.server.js") as { redis?: { del: (...keys: string[]) => Promise<number> } };
    if (redis) {
      await redis.del(
        `customer:${shop}:${customerId}:tags`,
        `customer:${shop}:${customerId}:segments`,
        `customer:${shop}:${customerId}:orders`,
      );
    }
  } catch {
    // Redis unavailable — cache will expire naturally
  }
}

async function handleCustomersDataRequest(shop: string, payload: CustomerGdprPayload) {
  const customerId = String(payload.customer?.id ?? "");
  const customerEmail = payload.customer?.email ?? "";
  const shopId = await getShopId(shop);

  console.info(`GDPR CUSTOMERS_DATA_REQUEST: shop=${shop} customerId=${customerId} email=${customerEmail}`);

  if (!shopId || !customerId) return;

  const db = getDb();
  const events = await db
    .select()
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.customerId, customerId)));

  const cartTokens = Array.from(new Set(events.flatMap((event) => event.cartToken ? [event.cartToken] : [])));
  const mutationLogs = cartTokens.length > 0
    ? await db
        .select()
        .from(cartMutationLogs)
        .where(and(eq(cartMutationLogs.shopId, shopId), inArray(cartMutationLogs.cartToken, cartTokens)))
    : [];

  const exportPayload = {
    requestedAt: new Date().toISOString(),
    customer: {
      id: customerId,
      email: customerEmail,
      phone: payload.customer?.phone ?? null,
    },
    ordersRequested: payload.orders_requested ?? [],
    analyticsEvents: events,
    cartMutationLogs: mutationLogs,
  };

  await db.insert(auditLogs).values({
    shopId,
    entityType: "gdpr_customer_data_request",
    entityId: customerId,
    action: "export",
    before: null,
    after: exportPayload,
    performedBy: "shopify_webhook",
  });

  console.info(`GDPR CUSTOMERS_DATA_REQUEST: exported ${events.length} analytics events and ${mutationLogs.length} mutation logs for customer ${customerId}`);
}

async function handleCustomersRedact(shop: string, payload: CustomerGdprPayload) {
  const customerId = String(payload.customer?.id ?? "");
  const shopId = await getShopId(shop);

  if (!shopId || !customerId) {
    console.warn(`GDPR CUSTOMERS_REDACT: missing shopId or customerId — shop=${shop}`);
    return;
  }

  const db = getDb();
  const deleted = await db
    .delete(analyticsEvents)
    .where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.customerId, customerId)))
    .returning({ id: analyticsEvents.id });

  console.info(`GDPR CUSTOMERS_REDACT: deleted ${deleted.length} events for customer ${customerId} shop=${shop}`);
}

async function handleShopRedact(shop: string) {
  const shopId = await getShopId(shop);

  if (!shopId) {
    console.warn(`GDPR SHOP_REDACT: shop not found — ${shop}`);
    return;
  }

  const db = getDb();

  // Delete PII-containing analytics data before marking the shop inactive.
  // Offer/conditions/rewards cascade via FK ON DELETE CASCADE when shop is deleted.
  await Promise.all([
    db.delete(analyticsEvents).where(eq(analyticsEvents.shopId, shopId)),
    db.delete(cartMutationLogs).where(eq(cartMutationLogs.shopId, shopId)),
  ]);

  await db
    .update(shops)
    .set({ isActive: false, uninstalledAt: new Date() })
    .where(eq(shops.id, shopId));

  console.info(`GDPR SHOP_REDACT: completed for shop=${shop} shopId=${shopId}`);
}
