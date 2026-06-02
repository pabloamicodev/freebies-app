import pino from "pino";
import { startProductSyncWorker } from "./product-sync.worker.js";
import { redis } from "./queues.js";

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
process.on("SIGTERM", async () => {
  log.info("SIGTERM received — shutting down workers");
  await productSyncWorker.close();
  await redis.quit();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("SIGINT received — shutting down workers");
  await productSyncWorker.close();
  await redis.quit();
  process.exit(0);
});

log.info("Workers running. Waiting for jobs...");
