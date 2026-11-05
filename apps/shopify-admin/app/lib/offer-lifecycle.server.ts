import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offerVersions, offers, shops, type Db } from "@promo/db";
import { normalizeExcludedPageUrls, normalizeStorePageUrls, validateConditionValue } from "@promo/shared-types";
import { insertAuditLog } from "./audit-log.server.js";
import { parseDateRange, toZonedLocalInput } from "./offer-validation.server.js";
import {
  getShopPublishWarnings,
  republishIfActive,
  tryPublishShop,
  validateActivation,
  type CapacityDetails,
  type PublishScope,
  type ShopPublishFn,
} from "./offer-publish-flow.server.js";
import { activationStatus, statusForScheduleSave, type OfferStatus } from "./offer-scheduling.server.js";

/**
 * Offer lifecycle: the single place that pauses, resumes, archives, reschedules and republishes.
 * Admin routes and the MCP write tools both call it, so both run exactly the same
 * validate -> update -> publish -> rollback -> audit sequence. No Response objects: callers map the
 * typed result to their own transport.
 *
 * A failed publish of the whole shop never pauses an offer (2026-10-20): the status writes done here
 * are rolled back, and `republishIfActive` (schedule / page URLs) keeps the status and retries later.
 */

export type { OfferStatus, ShopPublishFn };

export interface OfferLifecycleContext {
  shopId: string;
  shopDomain: string;
  offerId: string;
}

export interface OfferLifecycleOptions {
  /** Audit `performed_by`: the shop domain for the admin UI, `mcp:<operatorId>` for MCP. */
  performedBy: string;
  /** Merged into the audit row's `after` (e.g. `{ _mcp: { operator, client, tool, requestId } }`). */
  auditExtra?: Record<string, unknown>;
  /** Compute the outcome (validation, status before/after) without writing, publishing or auditing. */
  dryRun?: boolean;
  /** Replaces only the Shopify side. Defaults to the real shop publish. */
  publish?: ShopPublishFn;
  /** Optimistic concurrency: refuse when the offer changed since the caller read it. */
  expectedUpdatedAt?: Date;
  /** Replaces the advisory publish-warnings lookup (theme refs, experiments). */
  publishWarnings?: () => Promise<string[]>;
  /** Per-offer variant of `publishWarnings`, for bulk resume. */
  publishWarningsFor?: (offerId: string) => Promise<string[]>;
}

export interface OfferLifecycleSuccess {
  ok: true;
  dryRun: boolean;
  offerId: string;
  statusBefore: OfferStatus;
  statusAfter: OfferStatus;
  changed: boolean;
  /** Current value on a dry run; the written value otherwise. Feed it back as `expectedUpdatedAt`. */
  updatedAt: Date;
  /** What a schedule / page URL change resolved to. */
  details?: Record<string, unknown>;
  /** Advisory problems the offer goes live with (set only when there are any). Never blocks; also audited on execution. */
  warnings?: string[];
}

export type OfferLifecycleFailure =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "validation"; error: string; scope?: PublishScope; offerId?: string; capacity?: CapacityDetails }
  | { ok: false; code: "state"; error: string; reason: "invalid_status" | "already_in_state" | "stale" | "no_condition" }
  | {
      ok: false;
      code: "publish_failed";
      error: string;
      capacity?: CapacityDetails;
      /** True when the status written by this call was put back. False when the saved change stays (schedule, page URLs). */
      rolledBack: boolean;
      statusBefore: OfferStatus;
      statusAfter: OfferStatus;
    };

export type OfferLifecycleResult = OfferLifecycleSuccess | OfferLifecycleFailure;

export interface BulkLifecycleContext {
  shopId: string;
  shopDomain: string;
  offerIds: string[];
}

export type BulkLifecycleResult =
  | {
      ok: true;
      dryRun: boolean;
      offers: Array<{ offerId: string; statusBefore: OfferStatus; statusAfter: OfferStatus; warnings?: string[] }>;
    }
  | Extract<OfferLifecycleFailure, { code: "validation" }>
  | { ok: false; code: "publish_failed"; error: string; capacity?: CapacityDetails; rolledBack: true };

export type RepublishShopResult =
  | { ok: true; dryRun: boolean }
  | { ok: false; code: "publish_failed"; error: string; capacity?: CapacityDetails; rolledBack: false; scope: PublishScope; offerId?: string };

const notFound = { ok: false, code: "not_found" } as const;

const capacityOf = (failure: { capacity?: CapacityDetails }) => (failure.capacity ? { capacity: failure.capacity } : {});
const key = (ctx: OfferLifecycleContext) => and(eq(offers.shopId, ctx.shopId), eq(offers.id, ctx.offerId));

async function audit(
  db: Db,
  ctx: { shopId: string },
  opts: OfferLifecycleOptions,
  entry: { entityType?: string; entityId: string; action: string; before?: unknown; after?: Record<string, unknown> },
) {
  await insertAuditLog(db, {
    shopId: ctx.shopId,
    entityType: entry.entityType ?? "offer",
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before,
    after: entry.after || opts.auditExtra ? { ...entry.after, ...opts.auditExtra } : undefined,
    performedBy: opts.performedBy,
  });
}

async function liveWarnings(db: Db, ctx: OfferLifecycleContext, opts: OfferLifecycleOptions, statusAfter: OfferStatus): Promise<{ warnings?: string[] }> {
  if (statusAfter !== "active" && statusAfter !== "scheduled") return {};
  const warnings = await (opts.publishWarnings ?? (() => getShopPublishWarnings(db, ctx.shopId, ctx.shopDomain, ctx.offerId)))();
  return warnings.length > 0 ? { warnings } : {};
}

function staleFailure(current: Date, opts: OfferLifecycleOptions): OfferLifecycleFailure | null {
  if (opts.expectedUpdatedAt && opts.expectedUpdatedAt.getTime() !== current.getTime()) {
    return { ok: false, code: "state", reason: "stale", error: "The offer changed since it was read; read it again." };
  }
  return null;
}

type StatusIntent = "pause" | "resume" | "toggle";

async function changeStatus(
  db: Db,
  ctx: OfferLifecycleContext,
  opts: OfferLifecycleOptions,
  intent: StatusIntent,
): Promise<OfferLifecycleResult> {
  const publish = opts.publish ?? tryPublishShop;
  // The caller's view can be stale (another tab, the cron); the stored status is the truth.
  const [current] = await db
    .select({ status: offers.status, startsAt: offers.startsAt, endsAt: offers.endsAt, updatedAt: offers.updatedAt })
    .from(offers)
    .where(key(ctx))
    .limit(1);
  if (!current) return notFound;
  const statusBefore = current.status as OfferStatus;
  const stale = staleFailure(current.updatedAt, opts);
  if (stale) return stale;

  const pausing = intent === "pause" || (intent === "toggle" && statusBefore === "active");
  if (intent === "pause" && statusBefore !== "active" && statusBefore !== "scheduled") {
    return { ok: false, code: "state", reason: "invalid_status", error: `Only a live offer can be paused (status: ${statusBefore}).` };
  }
  if (intent === "resume" && statusBefore !== "paused") {
    return { ok: false, code: "state", reason: "invalid_status", error: `Only a paused offer can be resumed (status: ${statusBefore}).` };
  }

  let statusAfter: OfferStatus = "paused";
  if (!pausing) {
    const validation = await validateActivation(db, ctx.shopId, [ctx.offerId]);
    if (!validation.ok) {
      return {
        ok: false,
        code: "validation",
        error: validation.error ?? "Offer is not publishable.",
        scope: validation.scope,
        offerId: validation.offerId,
        capacity: validation.capacity,
      };
    }
    statusAfter = activationStatus(current.startsAt, current.endsAt);
  }
  const advisory = pausing ? {} : await liveWarnings(db, ctx, opts, statusAfter);

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      offerId: ctx.offerId,
      statusBefore,
      statusAfter,
      changed: statusBefore !== statusAfter,
      updatedAt: current.updatedAt,
      ...advisory,
    };
  }

  const updatedAt = new Date();
  await db.update(offers).set({ status: statusAfter, updatedAt }).where(key(ctx));
  const failure = await publish(ctx.shopId, ctx.shopDomain);
  if (failure) {
    // Conditional: a status the cron changed in between must not be overwritten.
    await db
      .update(offers)
      .set({ status: statusBefore, updatedAt: new Date() })
      .where(and(key(ctx), eq(offers.status, statusAfter)));
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: true, statusBefore, statusAfter: statusBefore };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerId,
    action: intent === "toggle" ? "toggle_status" : intent,
    before: { status: statusBefore },
    after: { status: statusAfter, ...advisory },
  });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore, statusAfter, changed: statusBefore !== statusAfter, updatedAt, ...advisory };
}

/** Pauses a live (active or scheduled) offer and republishes the shop without it. */
export const pauseOffer = (db: Db, ctx: OfferLifecycleContext, opts: OfferLifecycleOptions) =>
  changeStatus(db, ctx, opts, "pause");

/** Resumes a paused offer: validateActivation, then active / scheduled / expired by its dates. */
export const resumeOffer = (db: Db, ctx: OfferLifecycleContext, opts: OfferLifecycleOptions) =>
  changeStatus(db, ctx, opts, "resume");

/** The offers-list switch: pauses an active offer, switches any other one on (stored status decides). */
export const toggleOfferStatus = (db: Db, ctx: OfferLifecycleContext, opts: OfferLifecycleOptions) =>
  changeStatus(db, ctx, opts, "toggle");

export async function archiveOffer(
  db: Db,
  ctx: OfferLifecycleContext,
  opts: OfferLifecycleOptions,
): Promise<OfferLifecycleResult> {
  const publish = opts.publish ?? tryPublishShop;
  const [previous] = await db
    .select({ status: offers.status, archivedAt: offers.archivedAt, updatedAt: offers.updatedAt })
    .from(offers)
    .where(key(ctx))
    .limit(1);
  if (!previous) return notFound;
  const statusBefore = previous.status as OfferStatus;
  const stale = staleFailure(previous.updatedAt, opts);
  if (stale) return stale;
  if (statusBefore === "archived") {
    return { ok: false, code: "state", reason: "already_in_state", error: "The offer is already archived." };
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, offerId: ctx.offerId, statusBefore, statusAfter: "archived", changed: true, updatedAt: previous.updatedAt };
  }
  const updatedAt = new Date();
  await db.update(offers).set({ status: "archived", archivedAt: updatedAt, updatedAt }).where(key(ctx));
  const failure = await publish(ctx.shopId, ctx.shopDomain);
  if (failure) {
    await db
      .update(offers)
      .set({ status: previous.status, archivedAt: previous.archivedAt, updatedAt: new Date() })
      .where(key(ctx));
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: true, statusBefore, statusAfter: statusBefore };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerId,
    action: "archive",
    before: { status: statusBefore },
    after: { status: "archived" },
  });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore, statusAfter: "archived", changed: true, updatedAt };
}

async function restoreStatuses(db: Db, shopId: string, previous: Array<{ id: string; status: string }>) {
  await db.transaction(async (tx) => {
    await Promise.all(
      previous.map((row) =>
        tx
          .update(offers)
          .set({ status: row.status as OfferStatus, updatedAt: new Date() })
          .where(and(eq(offers.shopId, shopId), eq(offers.id, row.id))),
      ),
    );
  });
}

export async function bulkPauseOffers(
  db: Db,
  ctx: BulkLifecycleContext,
  opts: OfferLifecycleOptions,
): Promise<BulkLifecycleResult> {
  const publish = opts.publish ?? tryPublishShop;
  const scope = and(eq(offers.shopId, ctx.shopId), inArray(offers.id, ctx.offerIds));
  const previous = await db.select({ id: offers.id, status: offers.status }).from(offers).where(scope);
  const planned = previous.map((row) => ({ offerId: row.id, statusBefore: row.status as OfferStatus, statusAfter: "paused" as OfferStatus }));
  if (opts.dryRun) return { ok: true, dryRun: true, offers: planned };
  await db.update(offers).set({ status: "paused", updatedAt: new Date() }).where(scope);
  const failure = await publish(ctx.shopId, ctx.shopDomain);
  if (failure) {
    await restoreStatuses(db, ctx.shopId, previous);
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: true };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerIds.join(","),
    action: "bulk_pause",
    after: { offerIds: ctx.offerIds },
  });
  return { ok: true, dryRun: false, offers: planned };
}

export async function bulkResumeOffers(
  db: Db,
  ctx: BulkLifecycleContext,
  opts: OfferLifecycleOptions,
): Promise<BulkLifecycleResult> {
  const publish = opts.publish ?? tryPublishShop;
  const validation = await validateActivation(db, ctx.shopId, ctx.offerIds);
  if (!validation.ok) {
    return {
      ok: false,
      code: "validation",
      error: validation.error ?? "Offer is not publishable.",
      scope: validation.scope,
      offerId: validation.offerId,
        capacity: validation.capacity,
    };
  }
  const previous = await db
    .select({ id: offers.id, status: offers.status, startsAt: offers.startsAt, endsAt: offers.endsAt })
    .from(offers)
    .where(and(eq(offers.shopId, ctx.shopId), inArray(offers.id, ctx.offerIds)));
  const now = new Date();
  const lookup = opts.publishWarningsFor ?? ((offerId: string) => getShopPublishWarnings(db, ctx.shopId, ctx.shopDomain, offerId));
  const planned = await Promise.all(
    previous.map(async (row) => {
      const statusBefore = row.status as OfferStatus;
      const statusAfter = activationStatus(row.startsAt, row.endsAt, now) as OfferStatus;
      const wasLive = statusBefore === "active" || statusBefore === "scheduled";
      const warnings = wasLive ? [] : await lookup(row.id);
      return { offerId: row.id, statusBefore, statusAfter, ...(warnings.length > 0 ? { warnings } : {}) };
    }),
  );
  if (opts.dryRun) return { ok: true, dryRun: true, offers: planned };
  await db.transaction(async (tx) => {
    for (const row of previous) {
      await tx
        .update(offers)
        .set({ status: activationStatus(row.startsAt, row.endsAt, now), updatedAt: now })
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, row.id)));
    }
  });
  const failure = await publish(ctx.shopId, ctx.shopDomain);
  if (failure) {
    await restoreStatuses(db, ctx.shopId, previous);
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: true };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerIds.join(","),
    action: "bulk_activate",
    after: {
      offerIds: ctx.offerIds,
      ...(planned.some((o) => o.warnings) ? { warnings: Object.fromEntries(planned.filter((o) => o.warnings).map((o) => [o.offerId, o.warnings])) } : {}),
    },
  });
  return { ok: true, dryRun: false, offers: planned };
}

export interface SetScheduleInput extends OfferLifecycleContext {
  /** Wall-clock "YYYY-MM-DDTHH:mm" in `timezone` (or an ISO instant). `""`/null clears; undefined keeps the stored value. */
  startsAt?: string | null;
  endsAt?: string | null;
  /** Falls back to the offer's timezone, then `shopTimezone`, then the shop's. */
  timezone?: string | null;
  shopTimezone?: string;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function setOfferSchedule(
  db: Db,
  input: SetScheduleInput,
  opts: OfferLifecycleOptions,
): Promise<OfferLifecycleResult> {
  const ctx: OfferLifecycleContext = { shopId: input.shopId, shopDomain: input.shopDomain, offerId: input.offerId };
  const [offer] = await db.select().from(offers).where(key(ctx)).limit(1);
  if (!offer) return notFound;
  const statusBefore = offer.status as OfferStatus;
  const stale = staleFailure(offer.updatedAt, opts);
  if (stale) return stale;

  let fallbackTz = input.shopTimezone;
  if (!input.timezone && !offer.timezone && !fallbackTz) {
    const [shop] = await db.select({ timezone: shops.timezone }).from(shops).where(eq(shops.id, ctx.shopId)).limit(1);
    fallbackTz = shop?.timezone ?? "UTC";
  }
  const timezone = input.timezone || offer.timezone || fallbackTz || "UTC";
  if (!isValidTimeZone(timezone)) return { ok: false, code: "validation", error: "Timezone is invalid." };

  const raw = new FormData();
  raw.set("startsAt", input.startsAt === undefined ? toZonedLocalInput(offer.startsAt, timezone) : (input.startsAt ?? ""));
  raw.set("endsAt", input.endsAt === undefined ? toZonedLocalInput(offer.endsAt, timezone) : (input.endsAt ?? ""));
  const range = parseDateRange(raw, timezone);
  if (range.error) return { ok: false, code: "validation", error: range.error };
  const startsAt = input.startsAt === undefined ? offer.startsAt : range.data!.startsAt;
  const endsAt = input.endsAt === undefined ? offer.endsAt : range.data!.endsAt;

  const statusAfter = statusForScheduleSave(statusBefore, startsAt, endsAt);
  if (statusAfter === "active" && statusBefore !== "active") {
    const activation = await validateActivation(db, ctx.shopId, [ctx.offerId]);
    if (!activation.ok) {
      return {
        ok: false,
        code: "validation",
        error: activation.error ?? "Offer is not publishable.",
        scope: activation.scope,
        offerId: activation.offerId,
        capacity: activation.capacity,
      };
    }
  }
  const details = { startsAt, endsAt, timezone };
  const wasLive = statusBefore === "active" || statusBefore === "scheduled";
  const advisory = wasLive ? {} : await liveWarnings(db, ctx, opts, statusAfter);
  if (opts.dryRun) {
    return { ok: true, dryRun: true, offerId: ctx.offerId, statusBefore, statusAfter, changed: true, updatedAt: offer.updatedAt, details, ...advisory };
  }

  const updatedAt = new Date();
  await db.update(offers).set({ startsAt, endsAt, status: statusAfter, timezone, updatedAt }).where(key(ctx));
  const publishError = await republishIfActive(
    db,
    ctx.shopId,
    ctx.shopDomain,
    ctx.offerId,
    statusBefore === "active" || statusAfter === "active",
    opts.publish,
  );
  if (publishError) {
    const [now] = await db.select({ status: offers.status }).from(offers).where(key(ctx)).limit(1);
    return {
      ok: false,
      code: "publish_failed",
      error: publishError,
      rolledBack: false,
      statusBefore,
      statusAfter: (now?.status ?? statusAfter) as OfferStatus,
    };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerId,
    action: "set_schedule",
    before: { status: statusBefore, startsAt: offer.startsAt, endsAt: offer.endsAt, timezone: offer.timezone },
    after: { status: statusAfter, startsAt, endsAt, timezone, ...advisory },
  });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore, statusAfter, changed: true, updatedAt, details, ...advisory };
}

export interface SetPageUrlsInput extends OfferLifecycleContext {
  /** Replaces the list when given (empty array clears it); undefined keeps it. */
  excludeUrls?: string[];
  pageUrls?: string[];
  /** Which Store pages condition; defaults to the offer's first one. */
  conditionId?: string;
}

/** Sets `excludeUrls` / `pageUrls` of the offer's Store pages condition, with the UI's normalization and zod limits. */
export async function setOfferPageUrls(
  db: Db,
  input: SetPageUrlsInput,
  opts: OfferLifecycleOptions,
): Promise<OfferLifecycleResult> {
  const ctx: OfferLifecycleContext = { shopId: input.shopId, shopDomain: input.shopDomain, offerId: input.offerId };
  const [offer] = await db
    .select({ status: offers.status, updatedAt: offers.updatedAt })
    .from(offers)
    .where(key(ctx))
    .limit(1);
  if (!offer) return notFound;
  const status = offer.status as OfferStatus;
  const stale = staleFailure(offer.updatedAt, opts);
  if (stale) return stale;

  const rows = await db
    .select()
    .from(offerConditions)
    .where(
      and(
        eq(offerConditions.shopId, ctx.shopId),
        eq(offerConditions.offerId, ctx.offerId),
        eq(offerConditions.conditionType, "page_types"),
      ),
    )
    .orderBy(asc(offerConditions.sortOrder));
  const condition = input.conditionId ? rows.find((row) => row.id === input.conditionId) : rows[0];
  if (!condition) {
    return { ok: false, code: "state", reason: "no_condition", error: "The offer has no Store pages condition." };
  }

  const before = (condition.value ?? {}) as Record<string, unknown>;
  const value: Record<string, unknown> = { ...before };
  if (input.excludeUrls !== undefined) {
    const excludeUrls = normalizeExcludedPageUrls(input.excludeUrls);
    if (excludeUrls.length) value["excludeUrls"] = excludeUrls;
    else delete value["excludeUrls"];
  }
  if (input.pageUrls !== undefined) {
    const pageTypes = Array.isArray(value["pageTypes"]) ? (value["pageTypes"] as unknown[]) : [];
    const pageUrls = normalizeStorePageUrls(input.pageUrls);
    if (pageUrls.length && !pageTypes.includes("page")) {
      return { ok: false, code: "validation", error: "Page URLs only apply when the Pages kind is selected." };
    }
    if (pageUrls.length) value["pageUrls"] = pageUrls;
    else delete value["pageUrls"];
  }
  const parsed = validateConditionValue("page_types", value);
  if (!parsed.success) {
    return { ok: false, code: "validation", error: parsed.error.issues[0]?.message ?? "Condition value is invalid." };
  }
  const details = {
    conditionId: condition.id,
    before: { excludeUrls: before["excludeUrls"] ?? [], pageUrls: before["pageUrls"] ?? [] },
    after: { excludeUrls: value["excludeUrls"] ?? [], pageUrls: value["pageUrls"] ?? [] },
  };
  if (opts.dryRun) {
    return { ok: true, dryRun: true, offerId: ctx.offerId, statusBefore: status, statusAfter: status, changed: true, updatedAt: offer.updatedAt, details };
  }

  await db
    .update(offerConditions)
    .set({ value })
    .where(
      and(
        eq(offerConditions.shopId, ctx.shopId),
        eq(offerConditions.offerId, ctx.offerId),
        eq(offerConditions.id, condition.id),
      ),
    );
  const publishError = await republishIfActive(db, ctx.shopId, ctx.shopDomain, ctx.offerId, status === "active", opts.publish);
  if (publishError) {
    const [now] = await db.select({ status: offers.status }).from(offers).where(key(ctx)).limit(1);
    return {
      ok: false,
      code: "publish_failed",
      error: publishError,
      rolledBack: false,
      statusBefore: status,
      statusAfter: (now?.status ?? status) as OfferStatus,
    };
  }
  await audit(db, ctx, opts, {
    entityId: ctx.offerId,
    action: "set_page_urls",
    before: details.before,
    after: details.after,
  });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore: status, statusAfter: status, changed: true, updatedAt: offer.updatedAt, details };
}

/** Re-publishes the shop's config. Nothing to roll back: no offer is touched. */
export async function republishShop(
  db: Db,
  ctx: { shopId: string; shopDomain: string },
  opts: OfferLifecycleOptions,
): Promise<RepublishShopResult> {
  if (opts.dryRun) return { ok: true, dryRun: true };
  const failure = await (opts.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
  if (failure) {
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: false, scope: failure.scope, offerId: failure.offerId };
  }
  await audit(db, ctx, opts, { entityType: "shop", entityId: ctx.shopId, action: "republish_shop" });
  return { ok: true, dryRun: false };
}

/**
 * Draft -> live, the admin Publish button's sequence: needs a main condition and a reward, validateActivation,
 * the schedule-aware status, publish (status put back if it fails), then the version snapshot and the audit row.
 * The advisory theme / experiment warnings come back as `warnings` (and are audited); they never block.
 */
export async function activateDraftOffer(
  db: Db,
  ctx: OfferLifecycleContext,
  opts: OfferLifecycleOptions & {
    /** The admin Publish button also re-publishes a non-draft offer; MCP keeps the draft-only guard. */
    fromAnyStatus?: boolean;
  },
): Promise<OfferLifecycleResult> {
  const publish = opts.publish ?? tryPublishShop;
  const [offer] = await db
    .select({ status: offers.status, type: offers.type, startsAt: offers.startsAt, endsAt: offers.endsAt, updatedAt: offers.updatedAt })
    .from(offers)
    .where(key(ctx))
    .limit(1);
  if (!offer) return notFound;
  const stale = staleFailure(offer.updatedAt, opts);
  if (stale) return stale;
  const statusBefore = offer.status as OfferStatus;
  if (statusBefore !== "draft" && !opts.fromAnyStatus) {
    return { ok: false, code: "state", reason: "invalid_status", error: `Only a draft can be activated this way (status: ${statusBefore}).` };
  }
  const [mains, rewards] = await Promise.all([
    db.select({ id: offerConditions.id }).from(offerConditions).where(and(eq(offerConditions.shopId, ctx.shopId), eq(offerConditions.offerId, ctx.offerId), eq(offerConditions.scope, "main"))).limit(1),
    db.select({ id: offerRewards.id }).from(offerRewards).where(and(eq(offerRewards.shopId, ctx.shopId), eq(offerRewards.offerId, ctx.offerId))).limit(1),
  ]);
  if (mains.length === 0) return { ok: false, code: "validation", error: "Cannot publish: add at least one main condition before publishing." };
  if (rewards.length === 0) {
    return { ok: false, code: "validation", error: offer.type === "gift" ? "Cannot publish: Add a gift reward before publishing." : "Cannot publish: add at least one reward before publishing." };
  }
  const validation = await validateActivation(db, ctx.shopId, [ctx.offerId]);
  if (!validation.ok) {
    return { ok: false, code: "validation", error: validation.error ?? "Offer is not publishable.", scope: validation.scope, offerId: validation.offerId, capacity: validation.capacity };
  }
  const now = new Date();
  const statusAfter = activationStatus(offer.startsAt, offer.endsAt, now);
  const advisory = await liveWarnings(db, ctx, opts, statusAfter);
  if (opts.dryRun) {
    return { ok: true, dryRun: true, offerId: ctx.offerId, statusBefore, statusAfter, changed: true, updatedAt: offer.updatedAt, ...advisory };
  }
  await db.update(offers).set({ status: statusAfter, updatedAt: now }).where(key(ctx));
  const failure = await publish(ctx.shopId, ctx.shopDomain);
  if (failure) {
    await db
      .update(offers)
      .set({ status: statusBefore, updatedAt: new Date() })
      .where(and(key(ctx), eq(offers.status, statusAfter)));
    return { ok: false, code: "publish_failed", error: failure.message, ...capacityOf(failure), rolledBack: true, statusBefore, statusAfter: statusBefore };
  }
  const [offerSnapshot, condSnapshot, rewSnapshot, policySnapshot] = await Promise.all([
    db.select().from(offers).where(key(ctx)).limit(1),
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, ctx.shopId), eq(offerConditions.offerId, ctx.offerId))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, ctx.shopId), eq(offerRewards.offerId, ctx.offerId))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, ctx.shopId), eq(offerCombinationPolicies.offerId, ctx.offerId))).limit(1),
  ]);
  // FOR UPDATE keeps two concurrent publishes from computing the same version number.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM offers WHERE id = ${ctx.offerId} AND shop_id = ${ctx.shopId} FOR UPDATE`);
    const [last] = await tx
      .select({ versionNumber: offerVersions.versionNumber })
      .from(offerVersions)
      .where(and(eq(offerVersions.shopId, ctx.shopId), eq(offerVersions.offerId, ctx.offerId)))
      .orderBy(desc(offerVersions.versionNumber))
      .limit(1);
    await tx.insert(offerVersions).values({
      shopId: ctx.shopId,
      offerId: ctx.offerId,
      versionNumber: (last?.versionNumber ?? 0) + 1,
      snapshot: { offer: offerSnapshot[0], conditions: condSnapshot, rewards: rewSnapshot, combinationPolicy: policySnapshot[0] ?? null },
      createdBy: opts.performedBy,
    });
  });
  await audit(db, ctx, opts, { entityId: ctx.offerId, action: "publish", before: { status: statusBefore }, after: { status: statusAfter, ...advisory } });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore, statusAfter, changed: true, updatedAt: now, ...advisory };
}
