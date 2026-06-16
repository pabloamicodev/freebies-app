import Redis from "ioredis";
import pino from "pino";
import { Queue } from "bullmq";
import { startAnalyticsReconcileWorker } from "./reconcile.worker.js";
import { closeDb } from "@promo/db";

const log = pino({ name: "analytics-reconcile" });

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on("error", (err) => {
  log.error({ err: err.message }, "Redis connection error");
});

log.info("Starting analytics-reconcile worker...");

// Register daily retention cleanup as a repeatable job
const analyticsQueue = new Queue("analytics-reconcile", { connection: redis });
await analyticsQueue.add("cleanup-old-events", {}, {
  repeat: { every: 24 * 60 * 60 * 1000 },
  jobId: "analytics-cleanup-daily",
});

const worker = startAnalyticsReconcileWorker(redis);

worker.on("completed", (job) => {
  log.info({ jobId: job.id, queue: "analytics-reconcile" }, "Job completed");
});

worker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "Job failed");
});

worker.on("error", (error) => {
  log.error({ error: error.message }, "Worker error");
});

async function shutdown() {
  log.info("Shutting down analytics-reconcile worker");
  await worker.close();
  await closeDb();
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info("analytics-reconcile worker running. Waiting for jobs...");
