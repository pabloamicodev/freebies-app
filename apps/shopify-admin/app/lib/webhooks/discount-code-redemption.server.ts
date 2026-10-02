import type { Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import { waitUntil } from "@vercel/functions";
import { recordDiscountCodeRedemptions, type OrderCodePayload } from "../discount-codes.server.js";
import { publishShopConfig } from "../offer-publish-flow.server.js";
import { markPublishPending } from "../publish-pending.server.js";

export interface RedemptionDeps {
  /** Runs the republish after the webhook has answered. */
  defer?: (work: Promise<void>) => void;
  publish?: (shopId: string, shopDomain: string) => Promise<string | null>;
}

/**
 * orders/paid: count redemptions of this app's discount codes (idempotent per order) and, when a
 * code just hit its usage limit, republish so Shopify stops accepting it.
 *
 * The redemption is recorded synchronously: it is the durable fact, and it is cheap. The republish
 * (several Admin API calls) runs after the response, because Shopify drops a webhook that takes
 * over 5 s and would then redeliver it. If that republish fails, the shop is flagged
 * publish-pending and the offers cron retries it; a redelivered webhook also retries it, since the
 * exhausted state is derived from stored data.
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
  deps: RedemptionDeps = {},
): Promise<void> {
  if (!shopId || !order.discount_codes?.length) return;
  const { exhaustedOfferIds } = await recordDiscountCodeRedemptions(db, shopId, order);
  if (exhaustedOfferIds.length === 0) return;

  const publish = deps.publish ?? publishShopConfig;
  const defer = deps.defer ?? ((work: Promise<void>) => waitUntil(work));
  defer(
    (async () => {
      try {
        const error = await publish(shopId, shopDomain);
        if (!error) return;
        await markPublishPending(shopId);
        Sentry.captureMessage("Republish after discount code exhaustion failed", {
          level: "error",
          tags: { shopId },
          extra: { error, exhaustedOfferIds },
        });
      } catch (err) {
        await markPublishPending(shopId).catch(() => undefined);
        Sentry.captureException(err, { tags: { shopId, context: "code-exhaustion-republish" } });
      }
    })(),
  );
}
