import pino from "pino";
import { startOfferPublisherWorker } from "./publisher.worker.js";
import { redis } from "../../product-sync/src/queues.js";

const log = pino({ name: "offer-publisher" });
log.info("Starting offer publisher worker...");

const worker = startOfferPublisherWorker();

worker.on("completed", (job) => {
  log.info({ jobId: job.id }, "Offer config published");
});

worker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "Offer publish failed");
});

process.on("SIGTERM", async () => {
  await worker.close();
  await redis.quit();
  process.exit(0);
});
