import pino from "pino";
import { startOfferPublisherWorker } from "./publisher.worker.js";
import { redis } from "./queues.js";

const log = pino({ name: "offer-publisher" });
log.info("Starting offer publisher worker...");

const worker = startOfferPublisherWorker();

worker.on("completed", (job) => {
  log.info({ jobId: job.id }, "Offer config published");
});

worker.on("failed", (job, error) => {
  log.error({ jobId: job?.id, error: error.message }, "Offer publish failed");
});

async function shutdown() {
  await worker.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
