import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Records each processed webhook delivery by its unique Shopify-assigned id
 * so a retried delivery (same id) is a no-op instead of double-applying side
 * effects (duplicate analytics rows, duplicate order-cancelled events, ...). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  webhookId: text("webhook_id").primaryKey(),
  topic: text("topic").notNull(),
  shopDomain: text("shop_domain").notNull(),
  status: text("status").notNull().default("processing"),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  index("webhook_deliveries_status_attempt_idx").on(table.status, table.lastAttemptAt),
]);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
