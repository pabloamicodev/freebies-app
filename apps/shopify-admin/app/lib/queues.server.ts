/**
 * Shared BullMQ queue instances for the Shopify Admin app.
 * Replaces direct imports from the workers package (which are outside the app bundle).
 */
import { Queue } from "bullmq";
import Redis from "ioredis";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

function createQueue(name: string) {
  return new Queue(name, { connection: redis as Redis });
}

export const productSyncQueue = createQueue("product-sync");
export const inventorySyncQueue = createQueue("inventory-sync");
export const offerPublishQueue = createQueue("offer-publish");
export const analyticsReconcileQueue = createQueue("analytics-reconcile");
