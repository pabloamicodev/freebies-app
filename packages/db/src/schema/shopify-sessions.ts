import {
  bigint,
  boolean,
  integer,
  pgTable,
  varchar,
} from "drizzle-orm/pg-core";

export const shopifySessions = pgTable("shopify_sessions", {
  id: varchar("id", { length: 255 }).primaryKey(),
  shop: varchar("shop", { length: 255 }).notNull(),
  state: varchar("state", { length: 255 }).notNull(),
  isOnline: boolean("isOnline").notNull(),
  scope: varchar("scope", { length: 255 }),
  expires: integer("expires"),
  accessToken: varchar("accessToken", { length: 255 }),
  refreshToken: varchar("refreshToken", { length: 255 }),
  refreshTokenExpires: bigint("refreshTokenExpires", { mode: "number" }),
  userId: bigint("userId", { mode: "number" }),
  firstName: varchar("firstName", { length: 255 }),
  lastName: varchar("lastName", { length: 255 }),
  email: varchar("email", { length: 255 }),
  accountOwner: boolean("accountOwner"),
  locale: varchar("locale", { length: 255 }),
  collaborator: boolean("collaborator"),
  emailVerified: boolean("emailVerified"),
});

export type ShopifySessionRow = typeof shopifySessions.$inferSelect;
export type NewShopifySessionRow = typeof shopifySessions.$inferInsert;
