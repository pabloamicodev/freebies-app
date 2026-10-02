import {
  analyticsEvents,
  auditLogs,
  cartMutationLogs,
  discountCodeRedemptions,
  gdprExports,
  shops,
  webhookDeliveries,
  type Db,
} from "@promo/db";
import { and, eq, inArray, or } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import type { SessionStorageLike } from "./app-uninstalled.server.js";

/** How long a generated customers/data_request export stays downloadable. */
export const GDPR_EXPORT_RETENTION_DAYS = 30;

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
  const [mutationLogs, redemptions] = await Promise.all([
    cartTokens.length > 0
      ? db
          .select()
          .from(cartMutationLogs)
          .where(and(eq(cartMutationLogs.shopId, shopId), inArray(cartMutationLogs.cartToken, cartTokens)))
      : Promise.resolve([]),
    db
      .select()
      .from(discountCodeRedemptions)
      .where(and(eq(discountCodeRedemptions.shopId, shopId), inArray(discountCodeRedemptions.customerId, customerIds))),
  ]);

  // The export itself: everything this app holds about the customer, as JSON the merchant can
  // download from the admin and hand to the customer. It expires, and customers/redact deletes it.
  const requestedAt = new Date();
  const [stored] = await db
    .insert(gdprExports)
    .values({
      shopId,
      customerId,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + GDPR_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      payload: {
        exportVersion: 1,
        shop,
        requestedAt: requestedAt.toISOString(),
        customer: { id: customerId, email: customerEmail || null },
        ordersRequested: payload.orders_requested ?? [],
        data: {
          analyticsEvents: events,
          cartMutationLogs: mutationLogs,
          discountCodeRedemptions: redemptions,
        },
      },
    })
    .returning({ id: gdprExports.id });

  // Keep the audit trail PII-minimal: counts and the export id, never the customer payload.
  const exportSummary = {
    requestedAt: requestedAt.toISOString(),
    exportId: stored?.id ?? null,
    orderCount: payload.orders_requested?.length ?? 0,
    analyticsEventCount: events.length,
    cartMutationLogCount: mutationLogs.length,
    discountCodeRedemptionCount: redemptions.length,
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

    // The stored data-request export holds this customer's data too. Redemption rows stay (the
    // code's usage accounting needs them) but lose the customer link.
    await tx
      .delete(gdprExports)
      .where(and(eq(gdprExports.shopId, shopId), inArray(gdprExports.customerId, customerIds)));
    await tx
      .update(discountCodeRedemptions)
      .set({ customerId: null })
      .where(and(eq(discountCodeRedemptions.shopId, shopId), inArray(discountCodeRedemptions.customerId, customerIds)));

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
  triggeredAt: string | null = null,
): Promise<void> {
  if (!shopId) {
    console.warn(`GDPR SHOP_REDACT: shop not found — ${shop}`);
    return;
  }

  // Shopify sends shop/redact 48 h after the uninstall. A merchant who reinstalled in between is a
  // live customer again: wiping their shop row would delete their offers and codes. Redact only a
  // shop that is still uninstalled and was not reinstalled after the request was issued.
  const [current] = await db
    .select({ isActive: shops.isActive, installedAt: shops.installedAt, uninstalledAt: shops.uninstalledAt })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (current) {
    const issuedAt = triggeredAt ? new Date(triggeredAt) : null;
    const reinstalledSince =
      issuedAt !== null && !Number.isNaN(issuedAt.getTime()) && current.installedAt > issuedAt;
    if (current.isActive || current.uninstalledAt === null || reinstalledSince) {
      console.warn(`GDPR SHOP_REDACT skipped: shop is active or was reinstalled, shop=${shop}`);
      Sentry.captureMessage("GDPR shop redact skipped: shop is active or was reinstalled", {
        level: "warning",
        tags: { gdpr: "shop_redact_skipped", shop },
      });
      return;
    }
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
