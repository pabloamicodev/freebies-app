import {
  pgTable, uuid, text, timestamp, jsonb, index, bigint,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    eventName: text("event_name").notNull(),
    sessionId: text("session_id"),
    cartToken: text("cart_token"),
    customerId: text("customer_id"),
    offerId: uuid("offer_id"),
    offerVersion: text("offer_version"),
    widgetId: uuid("widget_id"),
    orderId: text("order_id"),
    abVariant: text("ab_variant"),
    properties: jsonb("properties").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analytics_events_shop_offer_time_idx").on(t.shopId, t.offerId, t.occurredAt),
    index("analytics_events_shop_session_idx").on(t.shopId, t.sessionId),
    index("analytics_events_shop_event_idx").on(t.shopId, t.eventName, t.occurredAt),
    index("analytics_events_order_idx").on(t.orderId),
  ],
);

export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEvent = typeof analyticsEvents.$inferInsert;

export const cartMutationLogs = pgTable(
  "cart_mutation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    cartToken: text("cart_token"),
    /**
     * Mutation type:
     * "add_gift" | "remove_gift" | "update_gift_quantity" |
     * "add_bundle" | "remove_bundle" | "apply_discount_code" |
     * "remove_discount_code" | "prepare_checkout"
     */
    mutationType: text("mutation_type").notNull(),
    offerId: uuid("offer_id"),
    /** "ajax_cart" | "storefront_api" | "checkout_extension" */
    source: text("source").notNull(),
    request: jsonb("request"),
    response: jsonb("response"),
    /** "success" | "error" | "skipped" */
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cart_mutation_logs_shop_time_idx").on(t.shopId, t.createdAt),
    index("cart_mutation_logs_status_idx").on(t.shopId, t.status, t.createdAt),
  ],
);

export type CartMutationLog = typeof cartMutationLogs.$inferSelect;

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    performedBy: text("performed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.shopId, t.entityType, t.entityId),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
