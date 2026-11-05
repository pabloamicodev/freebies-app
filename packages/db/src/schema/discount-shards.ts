import { pgTable, uuid, text, integer, jsonb, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { shops } from "./shops";

/**
 * One row per automatic discount node of a sharded Function config. Slot 0 is `shops.discount_id`
 * (it never moves); slots >= 1 hold the shard nodes created by the publisher.
 */
export const discountShards = pgTable(
  "discount_shards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"cart">(),
    slot: integer("slot").notNull(),
    discountNodeId: text("discount_node_id"),
    unitKeys: jsonb("unit_keys").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
    configBytes: integer("config_bytes"),
    configHash: text("config_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("discount_shards_shop_kind_slot").on(t.shopId, t.kind, t.slot),
    check("discount_shards_kind_check", sql`${t.kind} in ('cart')`),
  ],
);

export type DiscountShard = typeof discountShards.$inferSelect;
