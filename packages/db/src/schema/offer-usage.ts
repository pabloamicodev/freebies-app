import {
  pgTable, uuid, text, integer, timestamp, index, uniqueIndex, primaryKey,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";
import { offers } from "./offers";

/** One row per (order, offer) that discounted a customer's paid order; the unique index makes webhook redelivery a no-op. */
export const offerCustomerUsages = pgTable(
  "offer_customer_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    customerGid: text("customer_gid").notNull(),
    orderGid: text("order_gid").notNull(),
    /** How the order was attributed to the offer: 'title' | 'code' | 'line' (| 'backfill'). */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("offer_customer_usages_order_offer_idx").on(t.shopId, t.orderGid, t.offerId),
    index("offer_customer_usages_customer_idx").on(t.shopId, t.customerGid, t.offerId),
    index("offer_customer_usages_offer_idx").on(t.offerId),
  ],
);

/** Per-customer queue state for pushing usage counts to the customer metafield. */
export const offerUsageSync = pgTable(
  "offer_usage_sync",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    customerGid: text("customer_gid").notNull(),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** Cooldown: set while the shop lacks write_customers so its backlog cannot crowd out other shops. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.customerGid] }),
    index("offer_usage_sync_pending_idx").on(t.pendingSince),
  ],
);

export type OfferCustomerUsage = typeof offerCustomerUsages.$inferSelect;
export type NewOfferCustomerUsage = typeof offerCustomerUsages.$inferInsert;
export type OfferUsageSync = typeof offerUsageSync.$inferSelect;
