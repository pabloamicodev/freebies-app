import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache, shops, analyticsEvents, cartMutationLogs, auditLogs, offers, offerConditions, webhookDeliveries } from "@promo/db";
import { eq, and, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { decryptToken } from "../lib/token-crypto.server.js";
import { syncInventoryFromWebhook } from "../lib/sync/inventory-sync.server.js";
import {
  removeCollectionFromCache,
  syncCollectionFromWebhook,
} from "../lib/sync/collection-sync.server.js";
import { syncMarketsForShop } from "../lib/sync/market-sync.server.js";
import { publishOffersForShop } from "../lib/sync/offer-publisher.server.js";
import { reconcileOrderAttribution } from "../lib/sync/analytics-reconcile.server.js";
import { dispatchIntegrationEvents, PermanentIntegrationError } from "../lib/integration-dispatcher.server.js";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";

// Own Vercel function: Shopify drops webhook deliveries that take over 5s, so
// cold starts must not load the admin app.
export const config = { maxDuration: 60 };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
        await handleAppUninstalled(shop, triggeredAt);
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

interface OrderWebhookPayload {
  id: number;
  admin_graphql_api_id: string;
  cart_token: string | null;
  total_price?: string;
  total_price_set?: { shop_money?: { amount?: string } };
  email?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  customer?: { id: number; email?: string | null; phone?: string | null } | null;
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
        currencyCode,
        inventoryQuantity: variant.inventory_quantity,
        inventoryPolicy: (variant.inventory_policy ?? "DENY").toUpperCase(),
        // The product webhook has no `available` field (only /products.json does); derive it
        // the way Shopify does: untracked, oversell allowed, or stock on hand.
        availableForSale:
          variant.available ??
          (variant.inventory_management == null ||
            (variant.inventory_policy ?? "deny").toLowerCase() === "continue" ||
            (variant.inventory_quantity ?? 0) > 0),
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
  const shopRecord = await getShopForWebhook(shop);
  if (!shopRecord) return;
  const accessToken = await decryptToken(shopRecord.accessTokenEncrypted);
  await syncInventoryFromWebhook(shopRecord.id, shop, accessToken, payload.inventory_item_id);
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

async function handleOrderPaid(shop: string, order: OrderWebhookPayload) {
  const shopId = await getShopId(shop);
  if (!shopId) return;
  const db = getDb();
  // Offer attribution comes from LINE ITEM properties — the runtime tags each
  // gift/bundle/upsell line with `_promo_engine_offer_id` when it adds it to
  // the cart. note_attributes (cart-level) are never written by anything and
  // were always empty.
  const claimedOfferIds = [
    ...new Set(
      order.line_items.flatMap((item) =>
        item.properties.filter((p) => p.name === "_promo_engine_offer_id").map((p) => p.value),
      ),
    ),
  ].filter((id) => UUID_PATTERN.test(id));
  // Line item properties are buyer-controlled input. Only attribute offers
  // that actually belong to this shop; invalid UUIDs must never reach a UUID
  // database column or poison an otherwise valid webhook delivery.
  const validOfferRows = claimedOfferIds.length > 0
    ? await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.shopId, shopId), inArray(offers.id, claimedOfferIds)))
    : [];
  const offerIds = validOfferRows.map((offer) => offer.id);
  const sessionId = order.note_attributes
    ?.find((attr) => attr.name === "_promo_engine_session_id" || attr.name === "promo_engine_session_id")
    ?.value ?? null;
  const amount = Number.parseFloat(order.total_price_set?.shop_money?.amount ?? order.total_price ?? "0");
  const totalPriceCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  const customerId = order.customer?.id != null
    ? `gid://shopify/Customer/${order.customer.id}`
    : null;

  await Promise.all([
    reconcileOrderAttribution({
        shopId,
        orderId: String(order.id),
        orderGid: order.admin_graphql_api_id,
        cartToken: order.cart_token,
        customerId,
        totalPriceCents,
        offerIds,
        sessionId,
    }),
    dispatchIntegrationEvents(shopId, db, {
        event: "order_paid",
        shopDomain: shop,
        orderId: order.admin_graphql_api_id,
        offerIds,
        totalPriceCents,
        sessionId,
        customerId,
        customerEmail: order.customer?.email ?? order.contact_email ?? order.email ?? null,
        customerPhone: order.customer?.phone ?? order.phone ?? null,
        timestamp: new Date().toISOString(),
    }),
  ]);
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

// Shopify revokes the access token before this webhook is delivered, so no
// Admin API calls are possible here: gift clone products and the discount's
// function_config metafield stay in the store. Only local state is cleaned up.
// Every step is idempotent so Shopify retries (on 503) are safe.
async function handleAppUninstalled(shop: string, triggeredAt: string | null) {
  const db = getDb();

  // Shopify can deliver/retry this webhook after a faster reinstall already
  // happened (afterAuth sets installedAt=now()). Trust the reinstall over a
  // stale uninstall: otherwise the reinstalled shop loses its discount ids
  // and gets archived offers moments after coming back up.
  if (triggeredAt) {
    const triggeredDate = new Date(triggeredAt);
    if (!Number.isNaN(triggeredDate.getTime())) {
      const [current] = await db
        .select({ installedAt: shops.installedAt })
        .from(shops)
        .where(eq(shops.myshopifyDomain, shop))
        .limit(1);
      if (current && current.installedAt > triggeredDate) {
        console.info(`[webhooks] APP_UNINSTALLED skipped: shop reinstalled after trigger — shop=${shop}`);
        return;
      }
    }
  }

  const [shopRecord] = await db
    .update(shops)
    .set({
      isActive: false,
      uninstalledAt: new Date(),
      // Cleared so a reinstall can't inherit a discount node Shopify may have
      // deleted (or that a slow ensureDiscountNodes call would otherwise
      // trust without verifying — see discount-node.server.ts).
      discountId: null,
      deliveryDiscountId: null,
    })
    .where(eq(shops.myshopifyDomain, shop))
    .returning({ id: shops.id });

  if (shopRecord) {
    await db
      .update(offers)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(offers.shopId, shopRecord.id), eq(offers.status, "active")));
  }

  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length > 0) await sessionStorage.deleteSessions(sessions.map((s) => s.id));
}

async function handleCustomersUpdate(_shop: string, _payload: CustomerGdprPayload) {
  // No-op: customer cache is no longer Redis-backed; module-level cache expires naturally.
}

async function handleCustomersDataRequest(shop: string, payload: CustomerGdprPayload) {
  const rawCustomerId = String(payload.customer?.id ?? "");
  const customerId = rawCustomerId && /^\d+$/.test(rawCustomerId)
    ? `gid://shopify/Customer/${rawCustomerId}`
    : rawCustomerId;
  const customerIds = [...new Set([customerId, rawCustomerId].filter(Boolean))];
  const customerEmail = payload.customer?.email ?? "";
  const shopId = await getShopId(shop);

  console.info("GDPR CUSTOMERS_DATA_REQUEST received", {
    shop,
    hasCustomerId: Boolean(customerId),
    hasCustomerEmail: Boolean(customerEmail),
    ordersRequested: payload.orders_requested?.length ?? 0,
  });

  // GDPR data requests have a compliance deadline — this needs a human to act
  // on it, not just a database row. Sentry is the only alerting channel wired
  // up today, so route it there as a message (not an exception) so it isn't
  // filtered by the error-only beforeSend rules.
  Sentry.captureMessage("GDPR customer data request received", {
    level: "warning",
    tags: { gdpr: "customers_data_request", shop },
    extra: { customerId, hasCustomerEmail: Boolean(customerEmail) },
  });

  if (!shopId || !customerId) return;

  const db = getDb();
  // The web pixel historically sent the numeric customer id (or its GID) as
  // sessionId rather than customerId — match both columns or that older data
  // is silently missing from the compliance export.
  const events = await db
    .select()
    .from(analyticsEvents)
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      or(
        inArray(analyticsEvents.customerId, customerIds),
        inArray(analyticsEvents.sessionId, customerIds),
      ),
    ));

  const cartTokens = Array.from(new Set(events.flatMap((event) => event.cartToken ? [event.cartToken] : [])));
  const mutationLogs = cartTokens.length > 0
    ? await db
        .select()
        .from(cartMutationLogs)
        .where(and(eq(cartMutationLogs.shopId, shopId), inArray(cartMutationLogs.cartToken, cartTokens)))
    : [];

  // Keep the audit trail PII-minimal. The underlying rows remain available for
  // the compliance export until Shopify sends CUSTOMERS_REDACT; duplicating the
  // full customer payload here would create an easy-to-miss second PII store.
  const exportSummary = {
    requestedAt: new Date().toISOString(),
    orderCount: payload.orders_requested?.length ?? 0,
    analyticsEventCount: events.length,
    cartMutationLogCount: mutationLogs.length,
  };

  await db.insert(auditLogs).values({
    shopId,
    entityType: "gdpr_customer_data_request",
    entityId: customerId,
    action: "export",
    before: null,
    after: exportSummary,
    performedBy: "shopify_webhook",
  });

  console.info("GDPR CUSTOMERS_DATA_REQUEST export recorded", {
    shop,
    analyticsEventCount: events.length,
    mutationLogCount: mutationLogs.length,
  });
}

async function handleCustomersRedact(shop: string, payload: CustomerGdprPayload) {
  const rawCustomerId = String(payload.customer?.id ?? "");
  const customerId = rawCustomerId && /^\d+$/.test(rawCustomerId)
    ? `gid://shopify/Customer/${rawCustomerId}`
    : rawCustomerId;
  const customerIds = [...new Set([customerId, rawCustomerId].filter(Boolean))];
  const shopId = await getShopId(shop);

  if (!shopId || !customerId) {
    console.warn("GDPR CUSTOMERS_REDACT missing shop or customer identifier", {
      shop,
      hasCustomerId: Boolean(customerId),
    });
    return;
  }

  const db = getDb();

  // Collect session/cart identifiers linked to this customer before deletion,
  // so we can also purge cartMutationLogs (which has no customerId column).
  // Same historical sessionId-as-customer-id quirk as the data request handler —
  // match both columns so redaction actually erases that older data too.
  const customerEventMatch = or(
    inArray(analyticsEvents.customerId, customerIds),
    inArray(analyticsEvents.sessionId, customerIds),
  );
  const customerEvents = await db
    .select({ sessionId: analyticsEvents.sessionId, cartToken: analyticsEvents.cartToken })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.shopId, shopId), customerEventMatch));

  const sessionIds = [...new Set(customerEvents.map((e) => e.sessionId).filter(Boolean) as string[])];
  const cartTokens = [...new Set(customerEvents.map((e) => e.cartToken).filter(Boolean) as string[])];

  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shopId), customerEventMatch))
      .returning({ id: analyticsEvents.id });

    await tx
      .delete(auditLogs)
      .where(and(
        eq(auditLogs.shopId, shopId),
        eq(auditLogs.entityType, "gdpr_customer_data_request"),
        inArray(auditLogs.entityId, customerIds),
      ));

    if (cartTokens.length > 0 || sessionIds.length > 0) {
      const conditions = [
        ...(cartTokens.length > 0 ? [inArray(cartMutationLogs.cartToken, cartTokens)] : []),
        ...(sessionIds.length > 0 ? [inArray(cartMutationLogs.sessionId, sessionIds)] : []),
      ];
      await tx
        .delete(cartMutationLogs)
        .where(and(eq(cartMutationLogs.shopId, shopId), or(...conditions)));
    }

    console.info("GDPR CUSTOMERS_REDACT completed", {
      shop,
      deletedEventCount: deleted.length,
      purgedSessionIds: sessionIds.length,
      purgedCartTokens: cartTokens.length,
    });
  });
}

async function handleShopRedact(shop: string) {
  const shopId = await getShopId(shop);

  if (!shopId) {
    console.warn(`GDPR SHOP_REDACT: shop not found — ${shop}`);
    return;
  }

  const db = getDb();

  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) await sessionStorage.deleteSessions(sessions.map((s) => s.id));
  } catch (err) {
    console.error("GDPR SHOP_REDACT: failed to purge sessions", err instanceof Error ? err.message : err);
  }

  // webhookDeliveries has no shopId FK (only shopDomain, kept for dedup
  // lookups that run before a shop row necessarily exists) — it isn't reached
  // by the shops.id cascade below, so it needs its own explicit purge.
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.shopDomain, shop));

  // Deleting the shop row cascades to every table that references it
  // (offers, product/variant cache, analytics, audit logs, gift clones, ...) —
  // GDPR shop redaction means nothing about this shop should remain,
  // including the encrypted access token itself.
  await db.delete(shops).where(eq(shops.id, shopId));

  console.info(`GDPR SHOP_REDACT: completed for shop=${shop} shopId=${shopId}`);
}
