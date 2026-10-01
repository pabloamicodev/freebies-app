import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";
import { offers } from "./offers";

export const discountCodeStatusEnum = pgEnum("discount_code_status", ["active", "disabled", "exhausted"]);

/** One bulk-generation run; kept so a batch can be listed/exported/disabled as a unit. */
export const discountCodeBatches = pgTable(
  "discount_code_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull().default(""),
    length: integer("length").notNull(),
    charset: text("charset").notNull(),
    count: integer("count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("discount_code_batches_offer_idx").on(t.shopId, t.offerId)],
);

/** Codes are stored uppercase; they are unique per shop (Shopify code namespaces are shop-wide too). */
export const discountCodes = pgTable(
  "discount_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => discountCodeBatches.id, { onDelete: "set null" }),
    /** The code customers type (what is live on Shopify). Differs from requestedCode only after a collision. */
    code: text("code").notNull(),
    /** Set when the merchant's chosen code already existed in Shopify and `code` is a suffixed variant. */
    requestedCode: text("requested_code"),
    /** Title of the Shopify discount that held requestedCode, for the merchant-facing notice. */
    collisionNote: text("collision_note"),
    status: discountCodeStatusEnum("status").notNull().default("active"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    usageLimit: integer("usage_limit"),
    oncePerCustomer: boolean("once_per_customer").notNull().default(false),
    usageCount: integer("usage_count").notNull().default(0),
    /** Set while the code is attached to the offer's Shopify code node (backend A). */
    shopifySyncedAt: timestamp("shopify_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("discount_codes_shop_code_idx").on(t.shopId, t.code),
    index("discount_codes_offer_idx").on(t.shopId, t.offerId, t.status),
    index("discount_codes_batch_idx").on(t.batchId),
  ],
);

/** One row per (order, code); the unique index makes webhook redelivery a no-op. */
export const discountCodeRedemptions = pgTable(
  "discount_code_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
    codeId: uuid("code_id").references(() => discountCodes.id, { onDelete: "set null" }),
    code: text("code").notNull(),
    orderId: text("order_id").notNull(),
    customerId: text("customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("discount_code_redemptions_order_code_idx").on(t.shopId, t.orderId, t.code),
    index("discount_code_redemptions_code_idx").on(t.codeId),
  ],
);

export type DiscountCode = typeof discountCodes.$inferSelect;
export type NewDiscountCode = typeof discountCodes.$inferInsert;
export type DiscountCodeBatch = typeof discountCodeBatches.$inferSelect;
export type DiscountCodeRedemption = typeof discountCodeRedemptions.$inferSelect;
