import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/** Queue names — centralized to avoid typos. */
export const QUEUES = {
  PRODUCT_SYNC: "product-sync",
  INVENTORY_SYNC: "inventory-sync",
  ANALYTICS_RECONCILE: "analytics-reconcile",
  OFFER_PUBLISH: "offer-publish",
} as const;

export function createQueue(name: string) {
  return new Queue(name, { connection: redis });
}

export const productSyncQueue = createQueue(QUEUES.PRODUCT_SYNC);
export const inventorySyncQueue = createQueue(QUEUES.INVENTORY_SYNC);
export const offerPublishQueue = createQueue(QUEUES.OFFER_PUBLISH);
export const analyticsReconcileQueue = createQueue(QUEUES.ANALYTICS_RECONCILE);
