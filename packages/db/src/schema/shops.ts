import {
  pgTable, uuid, text, boolean, timestamp, unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopDomain: text("shop_domain").notNull().unique(),
  myshopifyDomain: text("myshopify_domain").notNull().unique(),
  /** AES-256-GCM encrypted access token — never stored in plaintext. */
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  storefrontPublicToken: text("storefront_public_token"),
  planName: text("plan_name"),
  currencyCode: text("currency_code").notNull(),
  timezone: text("timezone").notNull(),
  locale: text("locale"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Shop = typeof shops.$inferSelect;
export type NewShop = typeof shops.$inferInsert;

export const appSettings = pgTable(
  "app_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(), // JSON-serialized
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("app_settings_shop_key").on(t.shopId, t.key)],
);

export type AppSetting = typeof appSettings.$inferSelect;

export const shopsRelations = relations(shops, ({ many }) => ({
  settings: many(appSettings),
}));
