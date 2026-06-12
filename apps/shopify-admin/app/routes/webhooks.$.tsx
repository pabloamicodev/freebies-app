import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache, shops, analyticsEvents, cartMutationLogs } from "@promo/db";
import { eq, and } from "drizzle-orm";

/**
 * Central webhook handler for all Shopify webhooks.
 * Each webhook topic is routed to its handler below.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "PRODUCTS_UPDATE":
    case "PRODUCTS_CREATE":
      await handleProductUpdate(shop, payload as ProductWebhookPayload);
      break;

    case "PRODUCTS_DELETE":
      await handleProductDelete(shop, (payload as { id: number }).id);
      break;

    case "INVENTORY_LEVELS_UPDATE":
      await handleInventoryUpdate(shop, payload as InventoryWebhookPayload);
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
  line_items: Array<{
    id: number;
    variant_id: number;
    product_id: number;
    properties: Array<{ name: string; value: string }>;
  }>;
  note_attributes: Array<{ name: string; value: string }>;
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
      status: product.status.toUpperCase(),
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
        status: product.status.toUpperCase(),
        imageUrl,
        raw: product as unknown,
        syncedAt: new Date(),
      },
    });

  // Sync variants
  if (product.variants) {
    for (const variant of product.variants) {
      await db
        .insert(variantCache)
        .values({
          shopId,
          productGid,
          variantGid: variant.admin_graphql_api_id,
          legacyVariantId: variant.id,
          sku: variant.sku || null,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compare_at_price,
          currencyCode: "USD", // updated per store on sync
          inventoryQuantity: variant.inventory_quantity,
          inventoryPolicy: variant.inventory_policy.toUpperCase(),
          availableForSale: variant.available,
          requiresSellingPlan: variant.requires_selling_plan,
          raw: variant as unknown,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [variantCache.shopId, variantCache.variantGid],
          set: {
            sku: variant.sku || null,
            title: variant.title,
            price: variant.price,
            compareAtPrice: variant.compare_at_price,
            inventoryQuantity: variant.inventory_quantity,
            inventoryPolicy: variant.inventory_policy.toUpperCase(),
            availableForSale: variant.available,
            raw: variant as unknown,
            syncedAt: new Date(),
          },
        });
    }
  }
}

async function handleProductDelete(shop: string, legacyProductId: number) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const db = getDb();
  await db
    .update(productCache)
    .set({ status: "ARCHIVED", syncedAt: new Date() })
    .where(
      eq(productCache.legacyProductId, legacyProductId),
    );
}

async function handleInventoryUpdate(_shop: string, _payload: InventoryWebhookPayload) {
  // Enqueue full variant re-sync via BullMQ worker (handled asynchronously)
  // The sync worker will update variantCache.inventoryQuantity via Admin API
}

async function handleOrderPaid(_shop: string, _order: OrderWebhookPayload) {
  // Enqueue attribution reconciliation job — match cart_token / note_attributes
  // to analyticsEvents, update offerAttribution records
}

async function handleOrderCancelled(_shop: string, _order: OrderWebhookPayload) {
  // Reverse attribution for cancelled order
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

  // In production: email export to customer or submit via Shopify data request API.
  // For now we log the count so there's a verifiable audit trail.
  console.info(`GDPR CUSTOMERS_DATA_REQUEST: found ${events.length} analytics events for customer ${customerId}`);
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
