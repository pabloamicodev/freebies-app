import { analyticsEvents, auditLogs, cartMutationLogs, shops, webhookDeliveries, type Db } from "@promo/db";
import { and, eq, inArray, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import type { SessionStorageLike } from "./app-uninstalled.server.js";

export interface CustomerGdprPayload {
  customer?: {
    id?: number | string;
    email?: string;
    phone?: string;
  };
  orders_requested?: Array<{ id: number; name: string }>;
}

export async function handleCustomersDataRequest(
  db: Db,
  shopId: string | null,
  shop: string,
  payload: CustomerGdprPayload,
): Promise<void> {
  const rawCustomerId = String(payload.customer?.id ?? "");
  const customerId = rawCustomerId && /^\d+$/.test(rawCustomerId)
    ? `gid://shopify/Customer/${rawCustomerId}`
    : rawCustomerId;
  const customerIds = [...new Set([customerId, rawCustomerId].filter(Boolean))];
  const customerEmail = payload.customer?.email ?? "";

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

export async function handleCustomersRedact(
  db: Db,
  shopId: string | null,
  shop: string,
  payload: CustomerGdprPayload,
): Promise<void> {
  const rawCustomerId = String(payload.customer?.id ?? "");
  const customerId = rawCustomerId && /^\d+$/.test(rawCustomerId)
    ? `gid://shopify/Customer/${rawCustomerId}`
    : rawCustomerId;
  const customerIds = [...new Set([customerId, rawCustomerId].filter(Boolean))];

  if (!shopId || !customerId) {
    console.warn("GDPR CUSTOMERS_REDACT missing shop or customer identifier", {
      shop,
      hasCustomerId: Boolean(customerId),
    });
    return;
  }

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

export async function handleShopRedact(
  db: Db,
  sessionStorage: SessionStorageLike,
  shopId: string | null,
  shop: string,
): Promise<void> {
  if (!shopId) {
    console.warn(`GDPR SHOP_REDACT: shop not found — ${shop}`);
    return;
  }

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
