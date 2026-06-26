import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(1),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("rate_limits_window_start_idx").on(t.windowStart),
]);

export type RateLimit = typeof rateLimits.$inferSelect;
