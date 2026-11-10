import { capacityActions, capacityIncidents, offers, type CapacityIncident, type Db, type HeldOffer } from "@promo/db";
import * as Sentry from "@sentry/node";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { isCapacityModalCode, tooLargeReason, type CapacityModalCode } from "./capacity-modal-copy.js";
import type { CapturedCapacity } from "./capacity-capture.server.js";
import type { RecentAction } from "./capacity-workarounds.js";
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

/** The offers a publish is about to switch on (or keep live), with the status and version they have right now. */
export async function snapshotHeldOffers(db: Db, shopId: string, offerIds: readonly string[]): Promise<HeldOffer[]> {
  if (offerIds.length === 0) return [];
  const rows = await db.select({ id: offers.id, status: offers.status, updatedAt: offers.updatedAt }).from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, [...offerIds])));
  return rows.map((row) => ({ id: row.id, status: row.status, updatedAt: row.updatedAt.toISOString() }));
}

/** After the system itself changed an offer a block is holding (paused it), re-stamp it so that change is not mistaken for a merchant edit. */
export async function restampHeldOffer(db: Db, shopId: string, offerId: string): Promise<void> {
  try {
    const live = await db.select({ id: capacityIncidents.id, held: capacityIncidents.held }).from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.status, ["open", "dismissed"])));
    for (const incident of live) {
      if (!incident.held.some((entry) => entry.id === offerId)) continue;
      const [fresh] = await snapshotHeldOffers(db, shopId, [offerId]);
      if (!fresh) continue;
      await db.update(capacityIncidents).set({ held: incident.held.map((entry) => (entry.id === offerId ? fresh : entry)) }).where(eq(capacityIncidents.id, incident.id));
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { shopId, context: "capacity-held-restamp" } });
  }
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
    let held = block.held ?? [];
    if (held.length > 0) {
      // A repeat block keeps what earlier occurrences held; per offer the latest entry wins.
      const [existing] = await db
        .select({ held: capacityIncidents.held })
        .from(capacityIncidents)
        .where(and(eq(capacityIncidents.shopId, block.shopId), eq(capacityIncidents.dedupeKey, dedupeKey), inArray(capacityIncidents.status, ["open", "dismissed"])));
      if (existing) {
        const merged = new Map(existing.held.map((entry) => [entry.id, entry]));
        for (const entry of held) merged.set(entry.id, entry);
        held = [...merged.values()];
      }
    }
    const [row] = await db
      .insert(capacityIncidents)
      .values({
        shopId: block.shopId,
        code: block.code,
        reason: incidentReason(block),
        dedupeKey,
        offerIds,
        numbers: block.numbers,
        held,
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
          ...(held.length > 0 ? { held } : {}),
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
    // A fix whose publish was parked behind another publish is live now that one has succeeded.
    const awaiting = await db
      .select({ id: capacityActions.id, incidentId: capacityActions.incidentId })
      .from(capacityActions)
      .where(and(eq(capacityActions.shopId, shopId), eq(capacityActions.status, "applied"), sql`${capacityActions.snapshot} ? 'publishPending'`));
    let resolvedAwaiting = 0;
    if (awaiting.length > 0) {
      const done = await db
        .update(capacityIncidents)
        .set({ status: "resolved", resolution: "workaround", resolvedAt: sql`now()` })
        .where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.id, awaiting.map((row) => row.incidentId)), inArray(capacityIncidents.status, ["open", "dismissed"])))
        .returning({ id: capacityIncidents.id });
      resolvedAwaiting = done.length;
      await db
        .update(capacityActions)
        .set({ snapshot: sql`${capacityActions.snapshot} - 'publishPending'` })
        .where(and(eq(capacityActions.shopId, shopId), inArray(capacityActions.id, awaiting.map((row) => row.id))));
    }
    const live = await db
      .select()
      .from(capacityIncidents)
      .where(and(eq(capacityIncidents.shopId, shopId), inArray(capacityIncidents.status, ["open", "dismissed"])));
    if (live.length === 0) return resolvedAwaiting;
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
    return resolvedAwaiting + published.length + moot.length;
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

export async function recentActions(db: Db, shopId: string, limit = 10): Promise<RecentAction[]> {
  const rows = await db.select().from(capacityActions).where(eq(capacityActions.shopId, shopId)).orderBy(desc(capacityActions.createdAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    incidentId: row.incidentId,
    kind: row.kind,
    status: row.status,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    undoUntil: row.undoUntil?.toISOString() ?? null,
    error: row.error,
  }));
}
