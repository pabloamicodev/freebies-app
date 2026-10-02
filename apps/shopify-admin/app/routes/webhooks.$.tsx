import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache, shops, analyticsEvents, offers, offerConditions, webhookDeliveries } from "@promo/db";
import { eq, and, lt, notInArray, or, sql } from "drizzle-orm";
import { decryptToken } from "../lib/token-crypto.server.js";
import { coalescedDrain, enqueueCatalogRefresh } from "../lib/sync/inventory-sync-queue.server.js";
import { deriveWebhookAvailability, isStaleProductPayload } from "../lib/sync/variant-availability.js";
import {
  removeCollectionFromCache,
  syncCollectionFromWebhook,
} from "../lib/sync/collection-sync.server.js";
import { syncMarketsForShop } from "../lib/sync/market-sync.server.js";
import { publishOffersForShop } from "../lib/sync/offer-publisher.server.js";
import { PermanentIntegrationError } from "../lib/integration-dispatcher.server.js";
import { handleOrderPaid, type OrderWebhookPayload } from "../lib/webhooks/order-paid.server.js";
import type { OrderCodePayload } from "../lib/discount-codes.server.js";
import { handleDiscountCodeRedemptions } from "../lib/webhooks/discount-code-redemption.server.js";
import { handleAppUninstalled } from "../lib/webhooks/app-uninstalled.server.js";
import {
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  type CustomerGdprPayload,
} from "../lib/webhooks/gdpr.server.js";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";

// Own Vercel function: Shopify drops webhook deliveries that take over 5s, so
// cold starts must not load the admin app.
export const config = { maxDuration: 60 };

/**
 * Central webhook handler for all Shopify webhooks.
 * Each webhook topic is routed to its handler below.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const triggeredAt = request.headers.get("x-shopify-triggered-at");
  const { topic, shop, payload } = await authenticate.webhook(request);
  let deliveryClaimed = false;

  // Shopify retries a delivery on any non-2xx response — including the 503s
  // we intentionally return below for transient errors — so the same
  // webhook_id can arrive more than once. Record it first (atomically) and
  // skip processing entirely if it's already been handled.
  if (webhookId) {
    try {
      const db = getDb();
      const inserted = await db
        .insert(webhookDeliveries)
        .values({ webhookId, topic, shopDomain: shop, status: "processing" })
        .onConflictDoNothing()
        .returning({ webhookId: webhookDeliveries.webhookId });
      deliveryClaimed = inserted.length > 0;
      if (!deliveryClaimed) {
        const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
        const reclaimed = await db
          .update(webhookDeliveries)
          .set({
            status: "processing",
            attempts: sql`${webhookDeliveries.attempts} + 1`,
            lastError: null,
            lastAttemptAt: new Date(),
          })
          .where(and(
            eq(webhookDeliveries.webhookId, webhookId),
            or(
              eq(webhookDeliveries.status, "failed"),
              and(eq(webhookDeliveries.status, "processing"), lt(webhookDeliveries.lastAttemptAt, staleBefore)),
            ),
          ))
          .returning({ webhookId: webhookDeliveries.webhookId });
        deliveryClaimed = reclaimed.length > 0;
      }
      if (!deliveryClaimed) {
        const existing = await db
          .select({ status: webhookDeliveries.status })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, webhookId))
          .limit(1);
        if (existing[0]?.status === "processed") {
          console.info(`[webhooks] duplicate delivery ignored: topic=${topic} shop=${shop} webhookId=${webhookId}`);
          return new Response("OK", { status: 200 });
        }
        // Another invocation still owns the claim. Ask Shopify to retry rather
        // than acknowledging work whose completion is not yet durable.
        return new Response("Processing", { status: 503 });
      }
    } catch (dedupErr) {
      // If the dedup check itself fails, fail open — processing twice is
      // safer than never processing a legitimate webhook.
      console.error("[webhooks] dedup check failed, processing anyway", dedupErr instanceof Error ? dedupErr.message : dedupErr);
    }
  }

  // Every thrown handler error is retryable. Known permanent cases are handled
  // explicitly inside handlers without throwing. Acknowledging an unknown
  // failure would permanently lose the webhook and is never safe.
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

      case "COLLECTIONS_DELETE":
        await handleCollectionDelete(shop, (payload as { id: number }).id);
        break;

      case "MARKETS_CREATE":
      case "MARKETS_UPDATE":
      case "MARKETS_DELETE":
        await handleMarketChange(shop);
        break;

      case "ORDERS_PAID": {
        const shopId = await getShopId(shop);
        // The redemption count is the durable, cheap fact: record it before the slower
        // attribution / integration dispatch, and let its republish run after the response.
        await handleDiscountCodeRedemptions(
          getDb(),
          shopId,
          shop,
          payload as OrderWebhookPayload & OrderCodePayload,
        );
        await handleOrderPaid(getDb(), shopId, shop, payload as OrderWebhookPayload);
        break;
      }

      case "ORDERS_CANCELLED":
        await handleOrderCancelled(shop, payload as OrderWebhookPayload);
        break;

      case "APP_UNINSTALLED":
        await handleAppUninstalled(getDb(), sessionStorage, shop, triggeredAt);
        break;

      case "CUSTOMERS_DATA_REQUEST": {
        const shopId = await getShopId(shop);
        await handleCustomersDataRequest(getDb(), shopId, shop, payload as CustomerGdprPayload, webhookId);
        break;
      }

      case "CUSTOMERS_REDACT": {
        const shopId = await getShopId(shop);
        await handleCustomersRedact(getDb(), shopId, shop, payload as CustomerGdprPayload);
        break;
      }

      case "SHOP_REDACT": {
        const shopId = await getShopId(shop);
        await handleShopRedact(getDb(), sessionStorage, shopId, shop, triggeredAt);
        break;
      }

      default:
        console.warn(`Unhandled webhook topic: ${topic}`);
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { topic, shop } });
    console.error(`Webhook handler failed: topic=${topic} shop=${shop}`, err instanceof Error ? err.message : err);
    if (err instanceof PermanentIntegrationError) {
      if (webhookId && deliveryClaimed) {
        await getDb()
          .update(webhookDeliveries)
          .set({
            status: "processed",
            lastError: err.message.slice(0, 1_000),
            processedAt: new Date(),
            lastAttemptAt: new Date(),
          })
          .where(eq(webhookDeliveries.webhookId, webhookId));
      }
      return new Response("Processed with permanent integration failure", { status: 200 });
    }
    if (webhookId && deliveryClaimed) {
      try {
        await getDb()
          .update(webhookDeliveries)
          .set({
            status: "failed",
            lastError: err instanceof Error ? err.message.slice(0, 1_000) : "Webhook processing error",
            lastAttemptAt: new Date(),
          })
          .where(eq(webhookDeliveries.webhookId, webhookId));
      } catch (stateErr) {
        Sentry.captureException(stateErr, { tags: { topic, shop, context: "webhook-state" } });
      }
    }
    // Vercel can freeze the function the instant this response is sent — flush
    // before returning or the captured exceptions above may never be sent.
    waitUntil(Sentry.flush(2000));
    return new Response("Temporary error", { status: 503, headers: { "Retry-After": "30" } });
  }

  if (webhookId && deliveryClaimed) {
    await getDb()
      .update(webhookDeliveries)
      .set({ status: "processed", lastError: null, processedAt: new Date(), lastAttemptAt: new Date() })
      .where(eq(webhookDeliveries.webhookId, webhookId));
  }

  return new Response("OK", { status: 200 });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  updated_at?: string;
  variants?: Array<{
    id: number;
    admin_graphql_api_id: string;
    sku: string;
    title: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity: number;
    inventory_policy: string;
    inventory_management?: string | null;
    // Not present in the products/* webhook payload (only in Storefront /products.json).
    available?: boolean;
    requires_selling_plan?: boolean;
  }>;
  images?: Array<{ src: string }>;
}

interface InventoryWebhookPayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
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

async function getShopRecord(shopDomain: string): Promise<{ id: string; currencyCode: string } | null> {
  const db = getDb();
  const rows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode })
    .from(shops)
    .where(eq(shops.myshopifyDomain, shopDomain))
    .limit(1);
  return rows[0] ?? null;
}

// Kept for callers that only need the id
async function getShopId(shopDomain: string): Promise<string | null> {
  return (await getShopRecord(shopDomain))?.id ?? null;
}

async function handleProductUpdate(shop: string, product: ProductWebhookPayload) {
  const shopRecord = await getShopRecord(shop);
  if (!shopRecord) return;
  const shopId = shopRecord.id;
  const currencyCode = shopRecord.currencyCode || "USD";

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
  const [latest] = await db
    .select({ at: sql<Date | null>`max(${variantCache.syncedAt})` })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), eq(variantCache.productGid, productGid)));
  // An older payload (delivered late/out of order) would overwrite fresher inventory data.
  const stale = isStaleProductPayload(product.updated_at, latest?.at ? new Date(latest.at) : null);
  if (!stale && product.variants && product.variants.length > 0) {
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
        currencyCode,
        inventoryQuantity: variant.inventory_quantity,
        inventoryPolicy: (variant.inventory_policy ?? "DENY").toUpperCase(),
        // See deriveWebhookAvailability; refreshProductVariantsFromAdmin below overwrites it with Shopify's answer.
        ...deriveWebhookAvailability(variant),
        requiresSellingPlan: variant.requires_selling_plan ?? false,
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
          inventoryTracked: sql`coalesce(excluded.inventory_tracked, ${variantCache.inventoryTracked})`,
          raw: sql`excluded.raw`,
          syncedAt: sql`excluded.synced_at`,
        },
      });

    // Variants removed from the product must not linger as sellable cache rows.
    await db
      .delete(variantCache)
      .where(
        and(
          eq(variantCache.shopId, shopId),
          eq(variantCache.productGid, productGid),
          notInArray(variantCache.variantGid, product.variants.map((variant) => variant.admin_graphql_api_id)),
        ),
      );

    // The payload can't tell tracked from untracked stock, so the derived values are replaced with
    // Shopify's own, but not inside the webhook's 5 s window: queue it (a burst of edits to one
    // product coalesces) and let a background drain make the Admin API call.
    await enqueueCatalogRefresh(shopId, [{ kind: "product", ref: productGid }]);
    waitUntil(
      coalescedDrain(shopId).catch((error) => {
        Sentry.captureException(error, { extra: { shop, context: "product-refresh-drain" } });
      }),
    );
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

  // Keep the rows marked unsellable: a missing row is treated as "unknown, assume in stock".
  await db
    .update(variantCache)
    .set({ availableForSale: false, syncedAt: new Date() })
    .where(and(eq(variantCache.shopId, shopId), eq(variantCache.productGid, productGid)));
}

async function handleInventoryUpdate(shop: string, payload: InventoryWebhookPayload) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  // Inventory webhooks arrive in floods. The handler only records the item (events for the same
  // item coalesce into one row); the Admin API read happens after the response, batched.
  await enqueueCatalogRefresh(shopId, [
    { kind: "inventory_item", ref: `gid://shopify/InventoryItem/${payload.inventory_item_id}` },
  ]);
  waitUntil(
    coalescedDrain(shopId).catch((error) => {
      Sentry.captureException(error, { extra: { shop, context: "inventory-refresh-drain" } });
    }),
  );
}

async function handleMarketChange(shop: string) {
  const shopRecord = await getShopForWebhook(shop);
  if (!shopRecord) return;
  const accessToken = await decryptToken(shopRecord.accessTokenEncrypted);
  await syncMarketsForShop(shopRecord.id, shop, accessToken);
  // The Function only sees the country codes a markets condition resolved to
  // at publish time — republish so a changed market's countries apply at checkout.
  const [marketOffer] = await getDb()
    .select({ id: offers.id })
    .from(offers)
    .innerJoin(offerConditions, eq(offerConditions.offerId, offers.id))
    .where(and(
      eq(offers.shopId, shopRecord.id),
      eq(offers.status, "active"),
      eq(offerConditions.conditionType, "markets"),
      eq(offerConditions.isEnabled, true),
    ))
    .limit(1);
  if (marketOffer) {
    waitUntil(
      publishOffersForShop(shopRecord.id, shop).catch((error) => {
        Sentry.captureException(error, { extra: { shop, context: "markets-republish" } });
      }),
    );
  }
}

async function handleCollectionChange(shop: string, legacyCollectionId: number) {
  const shopRecord = await getShopForWebhook(shop);
  if (!shopRecord) return;
  const collectionGid = `gid://shopify/Collection/${legacyCollectionId}`;
  const accessToken = await decryptToken(shopRecord.accessTokenEncrypted);
  await syncCollectionFromWebhook(shopRecord.id, shop, accessToken, collectionGid);
}

async function handleCollectionDelete(shop: string, legacyCollectionId: number) {
  const shopId = await getShopId(shop);
  if (!shopId || !legacyCollectionId) return;
  await removeCollectionFromCache(
    shopId,
    `gid://shopify/Collection/${legacyCollectionId}`,
  );
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
    deduplicationKey: `shopify:${shopId}:order-cancelled:${order.admin_graphql_api_id}`,
    properties: {
      order_id: order.id,
    },
  }).onConflictDoNothing({ target: analyticsEvents.deduplicationKey });
}
