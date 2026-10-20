import { offers, type Db } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { reconcileOrderAttribution } from "../sync/analytics-reconcile.server.js";
import { dispatchIntegrationEvents } from "../integration-dispatcher.server.js";
import { recordOfferUsages, syncCustomerUsageMetafield, type PushUsage } from "../offer-usage.server.js";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OrderWebhookPayload {
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
    discount_allocations?: Array<{ amount: string }>;
  }>;
  note_attributes: Array<{ name: string; value: string }>;
  discount_applications?: Array<{ type: string; title?: string | null; code?: string | null }>;
  discount_codes?: Array<{ code?: string | null }>;
}

export interface OrderPaidDeps {
  /** Runs the customer metafield push after the webhook has answered. */
  defer?: (work: Promise<void>) => void;
  push?: PushUsage;
}

export async function handleOrderPaid(
  db: Db,
  shopId: string | null,
  shop: string,
  order: OrderWebhookPayload,
  deps: OrderPaidDeps = {},
): Promise<void> {
  if (!shopId) return;
  // The durable fact (one row per order and offer) is written first and is cheap. The metafield push
  // (an Admin API call) runs after the response; if it is lost, the customer stays pending and the
  // offers cron retries it.
  const usage = await recordOfferUsages(db, shopId, order);
  if (usage && usage.inserted > 0) {
    const defer = deps.defer ?? ((work: Promise<void>) => waitUntil(work));
    defer(
      syncCustomerUsageMetafield(db, shopId, usage.customerGid, deps.push).then(
        () => undefined,
        (err) => {
          Sentry.captureException(err, { tags: { shopId, context: "offer-usage-sync" } });
        },
      ),
    );
  }
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
