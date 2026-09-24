import {
  getDb,
  rateLimits,
  webhookDeliveries,
  type Db,
} from "@promo/db";
import { and, eq, lt } from "drizzle-orm";

export type OperationalRetentionSettings = {
  rateLimitHours?: number;
  processedWebhookDays?: number;
  failedWebhookDays?: number;
};

export function operationalRetentionCutoffs(
  now: Date,
  settings: OperationalRetentionSettings = {},
) {
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  return {
    staleRateLimits: new Date(
      now.getTime() - (settings.rateLimitHours ?? 24) * hour,
    ),
    processedWebhooks: new Date(
      now.getTime() - (settings.processedWebhookDays ?? 7) * day,
    ),
    failedWebhooks: new Date(
      now.getTime() - (settings.failedWebhookDays ?? 30) * day,
    ),
  };
}

export async function cleanupOperationalState(
  db: Db = getDb(),
  now = new Date(),
  settings: OperationalRetentionSettings = {},
): Promise<{
  rateLimits: number;
  processedWebhooks: number;
  failedWebhooks: number;
}> {
  const cutoffs = operationalRetentionCutoffs(now, settings);
  const staleRateLimits = await db
    .delete(rateLimits)
    .where(lt(rateLimits.updatedAt, cutoffs.staleRateLimits))
    .returning({ key: rateLimits.key });
  const processedWebhooks = await db
    .delete(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "processed"),
        lt(webhookDeliveries.processedAt, cutoffs.processedWebhooks),
      ),
    )
    .returning({ webhookId: webhookDeliveries.webhookId });
  const failedWebhooks = await db
    .delete(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "failed"),
        lt(webhookDeliveries.lastAttemptAt, cutoffs.failedWebhooks),
      ),
    )
    .returning({ webhookId: webhookDeliveries.webhookId });

  return {
    rateLimits: staleRateLimits.length,
    processedWebhooks: processedWebhooks.length,
    failedWebhooks: failedWebhooks.length,
  };
}
