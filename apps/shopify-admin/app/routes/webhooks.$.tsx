import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache, shops } from "@promo/db";
import { eq } from "drizzle-orm";

/**
 * Central webhook handler for all Shopify webhooks.
 * Each webhook topic is routed to its handler below.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

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
      // Invalidate customer segment cache via Redis (handled by worker)
      break;

    case "APP_UNINSTALLED":
      await handleAppUninstalled(shop);
      break;

    case "SHOP_REDACT":
    case "CUSTOMERS_REDACT":
    case "CUSTOMERS_DATA_REQUEST":
      // GDPR mandatory — log and confirm
      console.info(`GDPR webhook received: ${topic} for ${shop}`);
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
      raw: product as any,
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
        raw: product as any,
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
          raw: variant as any,
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
            raw: variant as any,
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

async function handleInventoryUpdate(shop: string, _payload: InventoryWebhookPayload) {
  // Enqueue full variant re-sync via BullMQ worker (handled asynchronously)
  // The sync worker will update variantCache.inventoryQuantity via Admin API
}

async function handleOrderPaid(shop: string, order: OrderWebhookPayload) {
  // Enqueue attribution reconciliation job — match cart_token / note_attributes
  // to analyticsEvents, update offerAttribution records
}

async function handleOrderCancelled(shop: string, order: OrderWebhookPayload) {
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
