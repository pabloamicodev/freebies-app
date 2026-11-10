import { pgTable, uuid, text, integer, jsonb, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { shops } from "./shops";

export type CapacityIncidentStatus = "open" | "resolved" | "dismissed";
export type CapacityIncidentResolution = "published" | "workaround" | "moot";
export type CapacityActionStatus = "pending" | "applied" | "rolled_back" | "undone" | "undo_failed";

/** An offer a blocked publish was switching on or keeping live, as it stood when the block happened. */
export interface HeldOffer {
  id: string;
  status: string;
  updatedAt: string;
}

/** A Shopify capacity limit that blocked a publish; persisted so unattended blocks stay visible. */
export const capacityIncidents = pgTable(
  "capacity_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    reason: text("reason"),
    dedupeKey: text("dedupe_key").notNull(),
    offerIds: text("offer_ids").array().notNull().default(sql`'{}'::text[]`),
    /** Offers the blocked publish was activating; only these (unchanged since) are auto-activated by a fix. */
    held: jsonb("held").notNull().$type<HeldOffer[]>().default(sql`'[]'::jsonb`),
    numbers: jsonb("numbers").notNull().$type<Record<string, number>>().default(sql`'{}'::jsonb`),
    source: text("source").notNull().$type<"admin" | "mcp" | "cron" | "background" | "webhook" | "auth">(),
    attended: boolean("attended").notNull().default(false),
    status: text("status").notNull().$type<CapacityIncidentStatus>().default("open"),
    resolution: text("resolution").$type<CapacityIncidentResolution>(),
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("capacity_incidents_shop_dedupe_live_idx")
      .on(t.shopId, t.dedupeKey)
      .where(sql`${t.status} in ('open','dismissed')`),
    index("capacity_incidents_shop_status_idx").on(t.shopId, t.status),
  ],
);

/** One workaround applied (or attempted) for an incident, with everything Undo needs in `snapshot`. */
export const capacityActions = pgTable(
  "capacity_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => capacityIncidents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    params: jsonb("params").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    snapshot: jsonb("snapshot").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    status: text("status").notNull().$type<CapacityActionStatus>().default("pending"),
    error: text("error"),
    performedBy: text("performed_by").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    undoUntil: timestamp("undo_until", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("capacity_actions_incident_pending_idx").on(t.incidentId).where(sql`${t.status} = 'pending'`),
    index("capacity_actions_shop_idx").on(t.shopId, t.createdAt),
  ],
);

export type CapacityIncident = typeof capacityIncidents.$inferSelect;
export type CapacityAction = typeof capacityActions.$inferSelect;
