import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Records each processed webhook delivery by its unique Shopify-assigned id
 * so a retried delivery (same id) is a no-op instead of double-applying side
 * effects (duplicate analytics rows, duplicate order-cancelled events, ...). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  webhookId: text("webhook_id").primaryKey(),
  topic: text("topic").notNull(),
  shopDomain: text("shop_domain").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
