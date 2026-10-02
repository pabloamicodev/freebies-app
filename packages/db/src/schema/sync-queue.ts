import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { shops } from "./shops";

/**
 * Work the products/inventory webhooks hand off instead of calling Shopify inside
 * their 5 s window. One row per (shop, kind, ref): bursts for the same item coalesce
 * into a single refresh. `leasedUntil` makes a claim crash-safe: a row whose lease
 * passed is claimable again.
 */
export const catalogRefreshQueue = pgTable(
  "catalog_refresh_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    /** "inventory_item" (ref = InventoryItem GID) or "product" (ref = Product GID). */
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("catalog_refresh_queue_item_idx").on(t.shopId, t.kind, t.ref),
    index("catalog_refresh_queue_due_idx").on(t.requestedAt),
  ],
);

/** Stored customers/data_request exports, downloadable from the admin until they expire. */
export const gdprExports = pgTable(
  "gdpr_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    /** x-shopify-webhook-id of the request; a redelivery must not store a second export. */
    webhookId: text("webhook_id"),
    payload: jsonb("payload").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("gdpr_exports_shop_customer_idx").on(t.shopId, t.customerId),
    uniqueIndex("gdpr_exports_shop_webhook_idx").on(t.shopId, t.webhookId),
    index("gdpr_exports_expires_idx").on(t.expiresAt),
  ],
);

export type CatalogRefreshQueueRow = typeof catalogRefreshQueue.$inferSelect;
export type GdprExport = typeof gdprExports.$inferSelect;
