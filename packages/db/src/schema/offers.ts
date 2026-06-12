import {
  pgTable, pgEnum, uuid, text, integer, boolean,
  timestamp, jsonb, unique, index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { shops } from "./shops";

export const offerTypeEnum = pgEnum("offer_type", [
  "gift", "bundle", "upsell", "discount", "booster",
]);

export const offerStatusEnum = pgEnum("offer_status", [
  "draft", "active", "paused", "scheduled", "expired", "archived",
]);

export const conditionScopeEnum = pgEnum("condition_scope", [
  "main", "sub", "quantity_limit", "visibility",
]);

export const conditionOperatorEnum = pgEnum("condition_operator", [
  "eq", "neq", "gt", "gte", "lt", "lte",
  "between", "in", "not_in", "contains", "not_contains", "all", "any",
]);

export const rewardTypeEnum = pgEnum("reward_type", [
  "product_gift", "shipping_discount", "product_discount",
  "order_discount", "bundle_discount", "upsell_discount",
]);

export const discountTypeEnum = pgEnum("discount_type", [
  "percentage", "fixed_amount", "fixed_price", "free",
  "cheapest_item_free", "most_expensive_item_discount",
]);

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    type: offerTypeEnum("type").notNull(),
    status: offerStatusEnum("status").notNull().default("draft"),
    internalName: text("internal_name").notNull(),
    publicTitle: text("public_title").notNull(),
    description: text("description"),
    priority: integer("priority").notNull().default(100),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    timezone: text("timezone"),
    /** Compiled config ready to push to Shopify Function metafield. */
    compiledConfig: jsonb("compiled_config"),
    /** GID of the metafield where compiled_config is stored. */
    functionMetafieldGid: text("function_metafield_gid"),
    /** Discount tags for campaign attribution (Shopify Admin API 2026-04). */
    discountTags: text("discount_tags").array().notNull().default([]),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offers_shop_internal_name").on(t.shopId, t.internalName),
    // Hot path: evaluator and admin list both filter by shopId+status
    index("offers_shop_status_idx").on(t.shopId, t.status),
    // Hot path: evaluator sorts by priority to pick winning offer
    index("offers_shop_priority_idx").on(t.shopId, t.priority),
  ],
);

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;

export const offerVersions = pgTable(
  "offer_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_versions_offer_version").on(t.offerId, t.versionNumber),
    index("offer_versions_offer_id_idx").on(t.offerId),
  ],
);

export type OfferVersion = typeof offerVersions.$inferSelect;

export const offerConditions = pgTable(
  "offer_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    scope: conditionScopeEnum("scope").notNull(),
    conditionType: text("condition_type").notNull(),
    operator: conditionOperatorEnum("operator").notNull(),
    /** Condition threshold / target — JSONB for flexibility. */
    value: jsonb("value").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Every condition lookup is by offerId — critical for evaluator hot path
    index("offer_conditions_offer_id_idx").on(t.offerId),
    index("offer_conditions_shop_id_idx").on(t.shopId),
  ],
);

export type OfferCondition = typeof offerConditions.$inferSelect;
export type NewOfferCondition = typeof offerConditions.$inferInsert;

export const offerRewards = pgTable(
  "offer_rewards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    rewardType: rewardTypeEnum("reward_type").notNull(),
    discountType: discountTypeEnum("discount_type").notNull(),
    /** Discount value — JSONB to support per-currency fixed amounts. */
    value: jsonb("value").notNull(),
    /** Target — variant IDs, product IDs, collection IDs. */
    target: jsonb("target").notNull(),
    quantity: integer("quantity"),
    isAutoAdd: boolean("is_auto_add").notNull().default(false),
    isCustomerSelectable: boolean("is_customer_selectable").notNull().default(false),
    /** "track_product" | "track_variant" */
    trackMode: text("track_mode").notNull().default("product"),
    sortOrder: integer("sort_order").notNull().default(0),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Every reward lookup is by offerId — needed for publish guard + evaluator
    index("offer_rewards_offer_id_idx").on(t.offerId),
    index("offer_rewards_shop_id_idx").on(t.shopId),
  ],
);

export type OfferReward = typeof offerRewards.$inferSelect;
export type NewOfferReward = typeof offerRewards.$inferInsert;

export const offerCombinationPolicies = pgTable(
  "offer_combination_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    combinesWithOrderDiscounts: boolean("combines_with_order_discounts").notNull().default(true),
    combinesWithProductDiscounts: boolean("combines_with_product_discounts").notNull().default(true),
    combinesWithShippingDiscounts: boolean("combines_with_shipping_discounts").notNull().default(true),
    combinesWithOtherAppOffers: boolean("combines_with_other_app_offers").notNull().default(true),
    stopLowerPriority: boolean("stop_lower_priority").notNull().default(false),
    giftValueCountsForOtherOffers: boolean("gift_value_counts_for_other_offers").notNull().default(false),
    maxApplicationsPerCart: integer("max_applications_per_cart"),
    maxApplicationsPerCustomer: integer("max_applications_per_customer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("offer_combination_policies_offer_id").on(t.offerId)],
);

export type OfferCombinationPolicy = typeof offerCombinationPolicies.$inferSelect;

export const offersRelations = relations(offers, ({ many, one }) => ({
  versions: many(offerVersions),
  conditions: many(offerConditions),
  rewards: many(offerRewards),
  combinationPolicy: one(offerCombinationPolicies, {
    fields: [offers.id],
    references: [offerCombinationPolicies.offerId],
  }),
}));
