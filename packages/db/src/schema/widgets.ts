import {
  pgTable, pgEnum, uuid, text, boolean, integer, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import { shops } from "./shops";
import { offers } from "./offers";

export const widgetTypeEnum = pgEnum("widget_type", [
  "gift_slider", "gift_popup", "cart_message", "today_offer_widget",
  "today_offer_block", "progress_bar", "gift_icon", "gift_thumbnail",
  "classic_bundle", "mix_match_bundle", "bundle_page",
  "checkout_upsell", "fbt", "thank_you_upsell", "volume_discount",
]);

export const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  offerId: uuid("offer_id").references(() => offers.id, { onDelete: "cascade" }),
  type: widgetTypeEnum("type").notNull(),
  internalName: text("internal_name").notNull(),
  title: text("title"),
  subtitle: text("subtitle"),
  /** Widget-specific config (colors, copy, layout). */
  config: jsonb("config").notNull().default({}),
  /** Theme overrides (CSS variables, class names). */
  theme: jsonb("theme").notNull().default({}),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Widget = typeof widgets.$inferSelect;
export type NewWidget = typeof widgets.$inferInsert;

export const widgetPlacements = pgTable("widget_placements", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  widgetId: uuid("widget_id")
    .notNull()
    .references(() => widgets.id, { onDelete: "cascade" }),
  /**
   * Placement type:
   * "theme_app_block" | "app_embed" | "css_selector_injection" |
   * "checkout_extension" | "thank_you_extension" | "headless_mount" | "pos"
   */
  placementType: text("placement_type").notNull(),
  /** CSS selector for injection-based placement. */
  selector: text("selector"),
  /** Page rules — JSONB: { pageType: "product" | "cart" | "all" | "custom", urlPattern?: string } */
  pageRule: jsonb("page_rule"),
  sortOrder: integer("sort_order").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WidgetPlacement = typeof widgetPlacements.$inferSelect;
