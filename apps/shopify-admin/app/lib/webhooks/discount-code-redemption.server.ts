import type { Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import { recordDiscountCodeRedemptions, type OrderCodePayload } from "../discount-codes.server.js";
import { publishShopConfig } from "../offer-publish-flow.server.js";

/**
 * orders/paid: count redemptions of this app's discount codes (idempotent per
 * order) and, when a code just hit its usage limit, republish so Shopify stops
 * accepting it. Failures here must not fail the order webhook's other work.
 *
 * Cancellations deliberately do NOT give usage back (no orders/cancelled
 * counterpart): Shopify keeps a code counted as used, and once-per-customer
 * checks keep seeing it, after the order that used it is cancelled (merchant and
 * community reports; no official doc says otherwise). Mirroring that keeps our
 * counters aligned with the node-level limits Shopify enforces itself.
 */
export async function handleDiscountCodeRedemptions(
  db: Db,
  shopId: string | null,
  shopDomain: string,
  order: OrderCodePayload,
): Promise<void> {
  if (!shopId || !order.discount_codes?.length) return;
  const { exhaustedOfferIds } = await recordDiscountCodeRedemptions(db, shopId, order);
  if (exhaustedOfferIds.length === 0) return;
  const error = await publishShopConfig(shopId, shopDomain);
  if (error) {
    Sentry.captureMessage("Republish after discount code exhaustion failed", {
      level: "error",
      tags: { shopId },
      extra: { error, exhaustedOfferIds },
    });
    throw new Error(error);
  }
}
