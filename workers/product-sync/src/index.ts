import pino from "pino";
import { startProductSyncWorker } from "./product-sync.worker.js";
import { redis } from "./queues.js";
import { closeDb } from "@promo/db";

const log = pino({ name: "workers" });

log.info("Starting Promo Engine workers...");

const productSyncWorker = startProductSyncWorker();

productSyncWorker.on("completed", (job) => {
  log.info({ jobId: job.id, queue: "product-sync" }, "Job completed");
});

productSyncWorker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "Job failed");
});

productSyncWorker.on("error", (error) => {
  log.error({ error: error.message }, "Worker error");
});

// Graceful shutdown
async function shutdown() {
  log.info("Shutting down product-sync worker");
  await productSyncWorker.close();
  await closeDb();
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info("Workers running. Waiting for jobs...");
