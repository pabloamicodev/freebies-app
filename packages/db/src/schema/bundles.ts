import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb, unique,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";
import { offers } from "./offers";
import { discountTypeEnum } from "./offers";

export const bundleDefinitions = pgTable(
  "bundle_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    /**
     * Bundle type:
     * "classic" | "mix_match" | "bundle_page" | "fixed_bundle" | "multipack" |
     * "variant_bundle" | "sample_pack" | "subscription_box" | "upsell_bundle" |
     * "cross_sell_bundle" | "custom_bundle"
     */
    bundleType: text("bundle_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    pageHeading: text("page_heading"),
    pageSubheading: text("page_subheading"),
    bannerImageUrl: text("banner_image_url"),
    /** "one_step_per_page" | "all_steps_one_page" */
    layoutMode: text("layout_mode").notNull().default("all_steps_one_page"),
    createBundleProduct: boolean("create_bundle_product").notNull().default(false),
    bundleProductGid: text("bundle_product_gid"),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("bundle_definitions_offer_id").on(t.offerId)],
);

export type BundleDefinition = typeof bundleDefinitions.$inferSelect;

export const bundleSteps = pgTable("bundle_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  bundleId: uuid("bundle_id")
    .notNull()
    .references(() => bundleDefinitions.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  /** "products" | "collection" | "vendor" | "product_type" */
  sourceType: text("source_type").notNull(),
  /** Source IDs / config — JSONB: { productGids: [...], collectionGid: "..." } */
  sourceConfig: jsonb("source_config").notNull(),
  minQuantity: integer("min_quantity"),
  maxQuantity: integer("max_quantity"),
  searchEnabled: boolean("search_enabled").notNull().default(false),
  /** Sort options: [{ value: "name_asc" | "name_desc" | "price_asc" | ... }] */
  sortOptions: jsonb("sort_options").notNull().default([]),
  /** Filter options: [{ type: "category" | "collection" | "tag" | "price_range", ... }] */
  filterOptions: jsonb("filter_options").notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BundleStep = typeof bundleSteps.$inferSelect;

export const bundleTiers = pgTable("bundle_tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  bundleId: uuid("bundle_id")
    .notNull()
    .references(() => bundleDefinitions.id, { onDelete: "cascade" }),
  minQuantity: integer("min_quantity").notNull(),
  label: text("label").notNull(),
  discountType: discountTypeEnum("discount_type").notNull(),
  /** Discount value — JSONB for multi-currency: { default: 10, USD: 10, EUR: 9 } */
  value: jsonb("value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BundleTier = typeof bundleTiers.$inferSelect;
