import {
  pgTable, uuid, text, boolean, timestamp, jsonb, bigint,
  numeric, index, unique,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";

export const productCache = pgTable(
  "product_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    productGid: text("product_gid").notNull(),
    legacyProductId: bigint("legacy_product_id", { mode: "number" }),
    handle: text("handle").notNull(),
    title: text("title").notNull(),
    vendor: text("vendor"),
    productType: text("product_type"),
    tags: text("tags").array().notNull().default([]),
    /** "ACTIVE" | "ARCHIVED" | "DRAFT" */
    status: text("status"),
    /** JSONB: { [salesChannelId]: boolean } */
    publishedScope: jsonb("published_scope"),
    /** JSONB: [{ marketId: string, isEnabled: boolean }] */
    markets: jsonb("markets"),
    /** Collection GIDs the product belongs to. */
    collections: text("collections").array().notNull().default([]),
    imageUrl: text("image_url"),
    /** Full raw product data from Admin API. */
    raw: jsonb("raw").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("product_cache_shop_gid").on(t.shopId, t.productGid),
    index("product_cache_shop_handle_idx").on(t.shopId, t.handle),
    index("product_cache_shop_tags_idx").on(t.shopId, t.tags),
  ],
);

export type ProductCache = typeof productCache.$inferSelect;
export type NewProductCache = typeof productCache.$inferInsert;

export const variantCache = pgTable(
  "variant_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    productGid: text("product_gid").notNull(),
    variantGid: text("variant_gid").notNull(),
    legacyVariantId: bigint("legacy_variant_id", { mode: "number" }),
    sku: text("sku"),
    title: text("title").notNull(),
    /** Price in store currency (stored as numeric for precision). */
    price: numeric("price", { precision: 18, scale: 4 }).notNull(),
    compareAtPrice: numeric("compare_at_price", { precision: 18, scale: 4 }),
    currencyCode: text("currency_code").notNull(),
    inventoryQuantity: bigint("inventory_quantity", { mode: "number" }),
    /** "CONTINUE" | "DENY" */
    inventoryPolicy: text("inventory_policy"),
    availableForSale: boolean("available_for_sale").notNull().default(true),
    requiresSellingPlan: boolean("requires_selling_plan").notNull().default(false),
    raw: jsonb("raw").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("variant_cache_shop_gid").on(t.shopId, t.variantGid),
    index("variant_cache_shop_product_idx").on(t.shopId, t.productGid),
    index("variant_cache_shop_sku_idx").on(t.shopId, t.sku),
  ],
);

export type VariantCache = typeof variantCache.$inferSelect;
export type NewVariantCache = typeof variantCache.$inferInsert;

/** Gift clone products created by the app in clone_product mode. */
export const giftCloneProducts = pgTable("gift_clone_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  offerId: uuid("offer_id").notNull(),
  rewardId: uuid("reward_id").notNull(),
  /** Source product GID (the actual product being gifted). */
  sourceProductGid: text("source_product_gid").notNull(),
  sourceVariantGid: text("source_variant_gid").notNull(),
  /** Clone product GID (price=0 or discounted, hidden from search). */
  cloneProductGid: text("clone_product_gid").notNull(),
  cloneVariantGid: text("clone_variant_gid").notNull(),
  cloneHandle: text("clone_handle").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GiftCloneProduct = typeof giftCloneProducts.$inferSelect;
