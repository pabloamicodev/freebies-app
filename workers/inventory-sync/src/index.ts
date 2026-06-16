import Redis from "ioredis";
import pino from "pino";
import { startInventorySyncWorker } from "./inventory-sync.worker.js";
import { closeDb } from "@promo/db";

const log = pino({ name: "inventory-sync" });

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on("error", (err) => {
  log.error({ err: err.message }, "Redis connection error");
});

log.info("Starting inventory-sync worker...");

const worker = startInventorySyncWorker(redis);

worker.on("completed", (job) => {
  log.info({ jobId: job.id, queue: "inventory-sync" }, "Job completed");
});

worker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "Job failed");
});

worker.on("error", (error) => {
  log.error({ error: error.message }, "Worker error");
});

async function shutdown() {
  log.info("Shutting down inventory-sync worker");
  await worker.close();
  await closeDb();
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info("inventory-sync worker running. Waiting for jobs...");
