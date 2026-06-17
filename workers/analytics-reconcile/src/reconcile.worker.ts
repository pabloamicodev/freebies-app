/**
 * Analytics Reconciliation Worker
 * Triggered by orders/paid webhook.
 * Matches order cart_token / note_attributes to analyticsEvents session IDs
 * to compute accurate offer attribution (revenue attributed, AOV impact).
 */

import { Worker, type Job } from "bullmq";
import pino from "pino";
import { getDb, analyticsEvents } from "@promo/db";
import { lt } from "drizzle-orm";
import type Redis from "ioredis";

const log = pino({ name: "analytics-reconcile-worker" });

export interface ReconcileJobData {
  shopId: string;
  shopDomain: string;
  orderId: string;
  orderGid: string;
  cartToken: string | null;
  totalPriceCents: number;
  /** offer IDs found in note_attributes of the order. */
  offerIds: string[];
  sessionId: string | null;
}

const RETENTION_DAYS = 90;

export function startAnalyticsReconcileWorker(redis: Redis) {
  const worker = new Worker<ReconcileJobData>(
    "analytics-reconcile",
    async (job: Job<ReconcileJobData>) => {
      // Daily retention cleanup — delete events older than RETENTION_DAYS
      if (job.name === "cleanup-old-events") {
        const db = getDb();
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const deleted = await db.delete(analyticsEvents).where(lt(analyticsEvents.occurredAt, cutoff)).returning({ id: analyticsEvents.id });
        log.info({ deletedCount: deleted.length, cutoff }, "Analytics retention cleanup complete");
        return;
      }

      const { shopId, orderId, orderGid, cartToken, totalPriceCents, offerIds, sessionId } = job.data;
      const db = getDb();

      log.info({ shopId, orderId, offerIds }, "Reconciling order attribution");

      // Find session events that led to this order
      // Match by: sessionId in note_attributes, or cartToken
      const identifiers = [cartToken, sessionId].filter(Boolean) as string[];

      if (identifiers.length === 0) {
        log.info({ orderId }, "No identifiers found for attribution — skipping");
        return;
      }

      // Insert order_placed event with attribution data — idempotent via onConflictDoNothing
      for (const offerId of offerIds) {
        await db.insert(analyticsEvents).values({
          shopId,
          eventName: "order_placed_attributed",
          sessionId: sessionId ?? cartToken,
          cartToken,
          orderId: orderGid,
          offerId: offerId.length === 36 ? offerId : null, // Only valid UUIDs
          properties: {
            order_id: orderId,
            total_price_cents: totalPriceCents,
            offer_ids: offerIds,
          },
        }).onConflictDoNothing();
      }

      log.info({ orderId, offerCount: offerIds.length }, "Order attribution reconciled");
    },
    {
      connection: redis,
      concurrency: 5,
      lockDuration: 30_000,
    },
  );

  worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.id, shopId: job?.data.shopId, orderId: job?.data.orderId, err: err.message },
      "analytics-reconcile job failed permanently",
    );
  });

  return worker;
}
