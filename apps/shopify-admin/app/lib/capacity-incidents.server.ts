import { capacityIncidents, offers, type CapacityIncident, type Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { isCapacityModalCode, tooLargeReason, type CapacityModalCode } from "./capacity-modal-copy.js";
import type { CapturedCapacity } from "./capacity-capture.server.js";
import { currentCapacityCaller, type CapacityCaller } from "./capacity-source.server.js";

const SHOP_WIDE_CODES: readonly string[] = ["AUTOMATIC_DISCOUNT_LIMIT", "SLOT_FULL", "COMBINATION_SINGLE_SHARD"] satisfies CapacityModalCode[];
const SNOOZE_SECONDS = 24 * 3600;

export function incidentReason(block: Pick<CapturedCapacity, "code" | "numbers" | "splitRefusal">): string | null {
  if (block.code !== "OFFER_TOO_LARGE") return null;
  return block.splitRefusal ?? tooLargeReason(block.numbers);
}

export function incidentDedupeKey(block: Pick<CapturedCapacity, "code" | "offerIds" | "numbers" | "splitRefusal">): string {
  if (SHOP_WIDE_CODES.includes(block.code)) return block.code;
  if (block.code === "OFFER_TOO_LARGE") return `${block.code}:${incidentReason(block)}:${block.offerIds[0] ?? ""}`;
  return `${block.code}:${[...block.offerIds].sort().join(",")}`;
}

/**
 * Persists a capacity block so unattended ones stay visible. Never throws into the publish path.
 * One live row per (shop, dedupe key): repeats bump `occurrences`; a dismissed row stays dismissed.
 */
export async function recordCapacityIncident(db: Db, block: CapturedCapacity, caller: CapacityCaller = currentCapacityCaller()): Promise<void> {
  if (!isCapacityModalCode(block.code)) return;
  try {
    const dedupeKey = incidentDedupeKey(block);
    const offerIds = [...new Set(block.offerIds)];
    const [row] = await db
      .insert(capacityIncidents)
      .values({
        shopId: block.shopId,
        code: block.code,
        reason: incidentReason(block),
        dedupeKey,
        offerIds,
        numbers: block.numbers,
        source: caller.source,
        attended: caller.attended,
      })
      .onConflictDoUpdate({
        target: [capacityIncidents.shopId, capacityIncidents.dedupeKey],
        targetWhere: sql`${capacityIncidents.status} in ('open','dismissed')`,
        set: {
          occurrences: sql`${capacityIncidents.occurrences} + 1`,
          lastSeenAt: sql`now()`,
          numbers: block.numbers,
          offerIds,
          source: caller.source,
          attended: caller.attended,
        },
      })
      .returning({ id: capacityIncidents.id });
    if (!row || caller.attended) return;
    // Atomic claim of the alert slot: at most one warning per incident every 6 hours, no Redis.
    const claimed = await db
      .update(capacityIncidents)
      .set({ lastAlertedAt: sql`now()` })
      .where(
        and(
          eq(capacityIncidents.id, row.id),
          or(isNull(capacityIncidents.lastAlertedAt), lt(capacityIncidents.lastAlertedAt, sql`now() - interval '6 hours'`)),
        ),
      )
      .returning({ id: capacityIncidents.id });
    if (claimed.length > 0) {
      Sentry.captureMessage("Capacity block while unattended", {
        level: "warning",
        tags: { shopId: block.shopId, code: block.code, source: caller.source },
        extra: { offerIds, numbers: block.numbers, reason: incidentReason(block) },
      });
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { shopId: block.shopId, context: "record-capacity-incident" } });
  }
}

/**
 * After a successful publish: incidents whose offers are all active are `published`; those whose offers
 * are all gone, archived or expired are `moot`. An offer the block left in draft or paused keeps its incident open.
 */
export async function resolveCapacityIncidents(db: Db, shopId: string): Promise<number> {
  try {
    const live = await db
      .select()
      .from(capacityIncidents)
      .where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.status, ["open", "dismissed"])));
    if (live.length === 0) return 0;
    const ids = [...new Set(live.flatMap((incident) => incident.offerIds))];
    const rows =
      ids.length === 0
        ? []
        : await db.select({ id: offers.id, status: offers.status }).from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, ids)));
    const statusById = new Map<string, string>(rows.map((row) => [row.id, row.status]));
    const published: string[] = [];
    const moot: string[] = [];
    for (const incident of live) {
      const statuses = incident.offerIds.map((id) => statusById.get(id));
      if (statuses.every((status) => status === "active")) published.push(incident.id);
      else if (statuses.every((status) => status === undefined || status === "archived" || status === "expired")) moot.push(incident.id);
    }
    const resolve = (incidentIds: string[], resolution: "published" | "moot") =>
      incidentIds.length === 0
        ? Promise.resolve()
        : db
            .update(capacityIncidents)
            .set({ status: "resolved", resolution, resolvedAt: sql`now()` })
            .where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.id, incidentIds)));
    await Promise.all([resolve(published, "published"), resolve(moot, "moot")]);
    return published.length + moot.length;
  } catch (error) {
    Sentry.captureException(error, { tags: { shopId, context: "resolve-capacity-incidents" } });
    return 0;
  }
}

export async function listOpenIncidents(db: Db, shopId: string): Promise<CapacityIncident[]> {
  return db
    .select()
    .from(capacityIncidents)
    .where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.status, ["open", "dismissed"])))
    .orderBy(desc(capacityIncidents.lastSeenAt));
}

export async function listRecentlyResolved(db: Db, shopId: string, days = 7): Promise<CapacityIncident[]> {
  return db
    .select()
    .from(capacityIncidents)
    .where(
      and(
        eq(capacityIncidents.shopId, shopId),
        eq(capacityIncidents.status, "resolved"),
        gt(capacityIncidents.resolvedAt, sql`now() - make_interval(days => ${days})`),
      ),
    )
    .orderBy(desc(capacityIncidents.resolvedAt));
}

/** Open incidents, and how many are not snoozed. One indexed query per layout load. */
export async function countOpenIncidents(db: Db, shopId: string): Promise<{ open: number; unsnoozed: number }> {
  const [row] = await db
    .select({
      open: sql<number>`count(*)::int`,
      unsnoozed: sql<number>`(count(*) filter (where ${capacityIncidents.snoozedUntil} is null or ${capacityIncidents.snoozedUntil} <= now()))::int`,
    })
    .from(capacityIncidents)
    .where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.status, "open")));
  return { open: row?.open ?? 0, unsnoozed: row?.unsnoozed ?? 0 };
}

export async function snoozeIncidents(db: Db, shopId: string): Promise<void> {
  await db
    .update(capacityIncidents)
    .set({ snoozedUntil: sql`now() + make_interval(secs => ${SNOOZE_SECONDS})` })
    .where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.status, "open")));
}

export async function dismissIncident(db: Db, shopId: string, incidentId: string): Promise<boolean> {
  const rows = await db
    .update(capacityIncidents)
    .set({ status: "dismissed", dismissedAt: sql`now()` })
    .where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.id, incidentId), eq(capacityIncidents.status, "open")))
    .returning({ id: capacityIncidents.id });
  return rows.length > 0;
}
