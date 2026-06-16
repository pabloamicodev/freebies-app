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

// Without this listener a connection error emits an unhandled 'error' event
// which terminates the Node.js process in production.
redis.on("error", (err) => {
  console.error("[Redis] connection error", err);
});

const JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1000 },
};

function createQueue(name: string) {
  return new Queue(name, { connection: redis as Redis, defaultJobOptions: JOB_DEFAULTS });
}

export const productSyncQueue = createQueue("product-sync");
export const inventorySyncQueue = createQueue("inventory-sync");
export const offerPublishQueue = createQueue("offer-publish");
export const analyticsReconcileQueue = createQueue("analytics-reconcile");
export const marketSyncQueue = createQueue("market-sync");
export const collectionSyncQueue = createQueue("collection-sync");
