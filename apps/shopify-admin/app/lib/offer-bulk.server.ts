import { and, eq, like } from "drizzle-orm";
import {
  analyticsEvents,
  appSettings,
  bundleDefinitions,
  cartMutationLogs,
  giftCloneProducts,
  offers,
  widgets,
  type Db,
} from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import { duplicateOffer } from "./offer-duplicate.server.js";
import {
  activateDraftOffer,
  archiveOffer,
  bulkResumeOffers,
  pauseOffer,
  resumeOffer,
  type OfferLifecycleContext,
  type OfferLifecycleFailure,
  type OfferLifecycleOptions,
  type OfferLifecycleResult,
  type OfferStatus,
} from "./offer-lifecycle.server.js";
import { tryPublishShop, type CapacityDetails } from "./offer-publish-flow.server.js";
import { neutralizeCodeDiscountNode } from "./sync/offer-publisher.server.js";

/**
 * Offer delete, explicit status targets and per-item bulk actions. The offers-list route and the MCP tools both
 * call these, so the UI and the MCP run the same sequences. No Request/Response here.
 */

export type DeleteOfferResult =
  | {
      ok: true;
      dryRun: boolean;
      offerId: string;
      name: string;
      statusBefore: OfferStatus;
      /** The offer was in the shop's published config (active or scheduled). */
      wasLive: boolean;
      /** Best-effort neutralize of a dedicated checkout-code discount node failed (the delete itself went through). */
      neutralizeError?: unknown;
    }
  | Extract<OfferLifecycleFailure, { code: "not_found" | "state" }>
  | {
      ok: false;
      code: "publish_failed";
      error: string;
      capacity?: CapacityDetails;
      /** Always false: the rows are gone, only the Shopify side is stale. */
      rolledBack: false;
      statusBefore: OfferStatus;
      statusAfter: OfferStatus;
    };

export interface DeleteOfferOptions extends OfferLifecycleOptions {
  /** Replaces the Shopify discount node neutralize (tests). */
  neutralizeCodeDiscount?: typeof neutralizeCodeDiscountNode;
  /** Skip the republish (bulk callers publish once at the end). */
  skipPublish?: boolean;
}

/**
 * Hard delete, as the offers list does it: removes the offer and its dependent rows (analytics, cart mutation
 * logs, gift clones, widgets, market overrides, bundle definition) in one transaction, neutralizes a dedicated
 * checkout-code discount node (best effort) and republishes the shop. A failed publish cannot be rolled back.
 */
export async function deleteOffer(db: Db, ctx: OfferLifecycleContext, opts: DeleteOfferOptions): Promise<DeleteOfferResult> {
  const { shopId, shopDomain, offerId } = ctx;
  const [row] = await db
    .select({ codeDiscountId: offers.codeDiscountId, status: offers.status, name: offers.internalName, updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };
  if (opts.expectedUpdatedAt && opts.expectedUpdatedAt.getTime() !== row.updatedAt.getTime()) {
    return { ok: false, code: "state", reason: "stale", error: "The offer changed since it was read; read it again." };
  }
  const statusBefore = row.status as OfferStatus;
  const wasLive = statusBefore === "active" || statusBefore === "scheduled";
  if (opts.dryRun) return { ok: true, dryRun: true, offerId, name: row.name, statusBefore, wasLive };

  await db.transaction(async (tx) => {
    await Promise.all([
      tx.delete(analyticsEvents).where(and(eq(analyticsEvents.shopId, shopId), eq(analyticsEvents.offerId, offerId))),
      tx.delete(cartMutationLogs).where(and(eq(cartMutationLogs.shopId, shopId), eq(cartMutationLogs.offerId, offerId))),
      tx.delete(giftCloneProducts).where(and(eq(giftCloneProducts.shopId, shopId), eq(giftCloneProducts.offerId, offerId))),
      tx.delete(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, `widget.market_overrides.${offerId}`))),
      tx.delete(widgets).where(and(eq(widgets.shopId, shopId), eq(widgets.offerId, offerId))),
      tx.delete(bundleDefinitions).where(and(eq(bundleDefinitions.shopId, shopId), eq(bundleDefinitions.offerId, offerId))),
    ]);
    await tx.delete(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  });

  // Once the row is gone, the regular publish can never find this offer again to neutralize its dedicated node, so do
  // it here: a deleted checkout-code promo must not keep discounting real orders with its last-known config.
  let neutralizeError: unknown;
  if (row.codeDiscountId) {
    try {
      await (opts.neutralizeCodeDiscount ?? neutralizeCodeDiscountNode)(shopId, shopDomain, row.codeDiscountId);
    } catch (err) {
      neutralizeError = err;
    }
  }

  if (!opts.skipPublish) {
    const failure = await (opts.publish ?? tryPublishShop)(shopId, shopDomain);
    if (failure) {
      return {
        ok: false,
        code: "publish_failed",
        error: failure.message,
        ...(failure.capacity ? { capacity: failure.capacity } : {}),
        rolledBack: false,
        statusBefore,
        statusAfter: statusBefore,
      };
    }
  }
  void insertAuditLog(db, {
    shopId,
    entityType: "offer",
    entityId: offerId,
    action: "delete",
    before: { status: statusBefore, name: row.name },
    after: opts.auditExtra,
    performedBy: opts.performedBy,
  });
  return { ok: true, dryRun: false, offerId, name: row.name, statusBefore, wasLive, ...(neutralizeError ? { neutralizeError } : {}) };
}

/** `name`, then `name (2)`, `name (3)`... until the (shop, internal_name) unique key is free. */
export async function uniqueOfferName(db: Db, shopId: string, desired: string): Promise<string> {
  const base = desired.slice(0, 120);
  const taken = new Set(
    (await db.select({ name: offers.internalName }).from(offers).where(and(eq(offers.shopId, shopId), like(offers.internalName, `${base.replace(/[\\%_]/g, "\\$&")}%`)))).map((r) => r.name),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 120 - ` (${n})`.length)} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not find a free offer name.");
}

export const SETTABLE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

const invalid = (error: string): OfferLifecycleFailure => ({ ok: false, code: "state", reason: "invalid_status", error });
const already = (status: string): OfferLifecycleFailure => ({ ok: false, code: "state", reason: "already_in_state", error: `The offer is already ${status}.` });

/**
 * Moves an offer to an explicit status through the lifecycle services (same validation, publish and rollback as the
 * admin buttons).
 *   draft    -> active    activateDraftOffer (conditions, reward, validateActivation + capacity preflight; the schedule picks active / scheduled / expired)
 *   paused   -> active    resumeOffer
 *   live     -> paused    pauseOffer
 *   any      -> archived  archiveOffer
 *   paused / live -> draft  unpublishes (status draft, shop republished, rolled back if that fails)
 * Everything else is an invalid transition (INVALID_STATE for the caller).
 */
export async function setOfferStatus(
  db: Db,
  ctx: OfferLifecycleContext,
  target: SettableStatus,
  opts: OfferLifecycleOptions,
): Promise<OfferLifecycleResult> {
  const [row] = await db
    .select({ status: offers.status })
    .from(offers)
    .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, ctx.offerId)))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };
  const from = row.status as OfferStatus;
  const live = from === "active" || from === "scheduled";

  switch (target) {
    case "archived":
      return archiveOffer(db, ctx, opts);
    case "paused":
      if (from === "paused") return already("paused");
      return pauseOffer(db, ctx, opts);
    case "active":
      if (live) return already(from);
      if (from === "draft") return activateDraftOffer(db, ctx, opts);
      if (from === "paused") return resumeOffer(db, ctx, opts);
      return invalid(`An ${from} offer cannot be activated; duplicate it or edit its schedule.`);
    case "draft":
      if (from === "draft") return already("draft");
      if (from === "archived") return invalid("An archived offer cannot go back to draft; duplicate it instead.");
      return returnToDraft(db, ctx, from, opts);
  }
}

async function returnToDraft(db: Db, ctx: OfferLifecycleContext, from: OfferStatus, opts: OfferLifecycleOptions): Promise<OfferLifecycleResult> {
  const key = and(eq(offers.shopId, ctx.shopId), eq(offers.id, ctx.offerId));
  const [current] = await db.select({ updatedAt: offers.updatedAt }).from(offers).where(key).limit(1);
  if (!current) return { ok: false, code: "not_found" };
  if (opts.expectedUpdatedAt && opts.expectedUpdatedAt.getTime() !== current.updatedAt.getTime()) {
    return { ok: false, code: "state", reason: "stale", error: "The offer changed since it was read; read it again." };
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, offerId: ctx.offerId, statusBefore: from, statusAfter: "draft", changed: true, updatedAt: current.updatedAt };
  }
  const updatedAt = new Date();
  await db.update(offers).set({ status: "draft", updatedAt }).where(key);
  const failure = await (opts.publish ?? tryPublishShop)(ctx.shopId, ctx.shopDomain);
  if (failure) {
    await db.update(offers).set({ status: from, updatedAt: new Date() }).where(and(key, eq(offers.status, "draft")));
    return {
      ok: false,
      code: "publish_failed",
      error: failure.message,
      ...(failure.capacity ? { capacity: failure.capacity } : {}),
      rolledBack: true,
      statusBefore: from,
      statusAfter: from,
    };
  }
  await insertAuditLog(db, {
    shopId: ctx.shopId,
    entityType: "offer",
    entityId: ctx.offerId,
    action: "return_to_draft",
    before: { status: from },
    after: { status: "draft", ...opts.auditExtra },
    performedBy: opts.performedBy,
  });
  return { ok: true, dryRun: false, offerId: ctx.offerId, statusBefore: from, statusAfter: "draft", changed: true, updatedAt };
}

export const BULK_ACTIONS = ["pause", "activate", "archive", "duplicate", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const MAX_BULK_ITEMS = 200;

export type BulkItemResult = {
  offerId: string;
  ok: boolean;
  /** Dry run: the action would work. */
  dryRun: boolean;
  statusBefore?: OfferStatus;
  statusAfter?: OfferStatus | "deleted";
  /** duplicate: the new draft. */
  newOfferId?: string;
  warnings?: string[];
  error?: { code: "not_found" | "validation" | "invalid_state" | "state_conflict" | "publish_failed" | "capacity"; message: string; capacity?: CapacityDetails };
};

export type BulkResult = { action: BulkAction; dryRun: boolean; items: BulkItemResult[]; succeeded: number; failed: number };

const itemError = (offerId: string, failure: OfferLifecycleFailure | Extract<DeleteOfferResult, { ok: false }>): BulkItemResult => {
  const capacity = "capacity" in failure ? failure.capacity : undefined;
  switch (failure.code) {
    case "not_found":
      return { offerId, ok: false, dryRun: false, error: { code: "not_found", message: "Offer not found in this shop." } };
    case "validation":
      return { offerId, ok: false, dryRun: false, error: { code: capacity ? "capacity" : "validation", message: failure.error, ...(capacity ? { capacity } : {}) } };
    case "state":
      return { offerId, ok: false, dryRun: false, error: { code: failure.reason === "stale" ? "state_conflict" : "invalid_state", message: failure.error } };
    case "publish_failed":
      return {
        offerId,
        ok: false,
        dryRun: false,
        statusBefore: failure.statusBefore,
        error: { code: capacity ? "capacity" : "publish_failed", message: failure.error, ...(capacity ? { capacity } : {}) },
      };
  }
};

const itemOk = (offerId: string, dryRun: boolean, r: { statusBefore?: OfferStatus; statusAfter?: OfferStatus | "deleted"; warnings?: string[]; newOfferId?: string }): BulkItemResult => ({
  offerId,
  ok: true,
  dryRun,
  ...(r.statusBefore ? { statusBefore: r.statusBefore } : {}),
  ...(r.statusAfter ? { statusAfter: r.statusAfter } : {}),
  ...(r.newOfferId ? { newOfferId: r.newOfferId } : {}),
  ...(r.warnings?.length ? { warnings: r.warnings } : {}),
});

/**
 * One action over many offers of one shop with a per-item result; a failing item never aborts the batch.
 * pause / activate / delete / archive republish the shop ONCE for the whole batch (all items that passed their
 * checks); if that single publish fails the items that depended on it are reported as publish_failed (statuses
 * restored, except delete: the rows are gone).
 */
export async function bulkOffers(
  db: Db,
  ctx: { shopId: string; shopDomain: string; offerIds: string[] },
  action: BulkAction,
  opts: OfferLifecycleOptions & Pick<DeleteOfferOptions, "neutralizeCodeDiscount">,
): Promise<BulkResult> {
  const ids = [...new Set(ctx.offerIds)];
  const dryRun = Boolean(opts.dryRun);
  const one = (offerId: string): OfferLifecycleContext => ({ shopId: ctx.shopId, shopDomain: ctx.shopDomain, offerId });
  const publish = opts.publish ?? tryPublishShop;
  const items: BulkItemResult[] = [];
  const noPublish = { ...opts, publish: async () => null };

  if (action === "duplicate") {
    for (const id of ids) {
      const [src] = await db
        .select({ name: offers.internalName, status: offers.status })
        .from(offers)
        .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, id)))
        .limit(1);
      if (!src) {
        items.push(itemError(id, { ok: false, code: "not_found" }));
        continue;
      }
      if (dryRun) {
        items.push(itemOk(id, true, { statusBefore: src.status as OfferStatus, statusAfter: "draft" }));
        continue;
      }
      const name = await uniqueOfferName(db, ctx.shopId, `${src.name}-copy`);
      const newOfferId = await duplicateOffer(db, ctx.shopId, id, { name });
      if (!newOfferId) {
        items.push(itemError(id, { ok: false, code: "not_found" }));
        continue;
      }
      await insertAuditLog(db, {
        shopId: ctx.shopId,
        entityType: "offer",
        entityId: newOfferId,
        action: "duplicate",
        before: { sourceOfferId: id },
        after: { status: "draft", name, ...opts.auditExtra },
        performedBy: opts.performedBy,
      });
      items.push(itemOk(id, false, { statusBefore: src.status as OfferStatus, statusAfter: "draft", newOfferId }));
    }
  } else if (action === "pause") {
    const eligible: string[] = [];
    for (const id of ids) {
      const r = await pauseOffer(db, one(id), { ...opts, dryRun: true });
      if (!r.ok) items.push(itemError(id, r));
      else eligible.push(id);
    }
    if (dryRun) for (const id of eligible) items.push(itemOk(id, true, { statusAfter: "paused" }));
    else await runBatch(eligible, items, (id) => pauseOffer(db, one(id), noPublish), publish, ctx, db, "paused");
  } else if (action === "activate") {
    const paused: string[] = [];
    const drafts: string[] = [];
    for (const id of ids) {
      const r = await setOfferStatus(db, one(id), "active", { ...opts, dryRun: true });
      if (!r.ok) {
        items.push(itemError(id, r));
        continue;
      }
      items.push(itemOk(id, true, { statusBefore: r.statusBefore, statusAfter: r.statusAfter, warnings: r.warnings }));
      (r.statusBefore === "draft" ? drafts : paused).push(id);
    }
    // A dry run keeps the preview rows pushed above.
    if (!dryRun) {
      // Drop the preview rows of what is about to run; the executed rows replace them.
      const run = new Set([...paused, ...drafts]);
      for (let i = items.length - 1; i >= 0; i--) if (items[i]!.ok && run.has(items[i]!.offerId)) items.splice(i, 1);
      if (paused.length > 0) {
        const result = await bulkResumeOffers(db, { shopId: ctx.shopId, shopDomain: ctx.shopDomain, offerIds: paused }, { ...opts, dryRun: false });
        if (result.ok) {
          for (const o of result.offers) items.push(itemOk(o.offerId, false, o));
        } else {
          for (const id of paused) items.push(itemError(id, result.code === "publish_failed" ? { ...result, statusBefore: "paused", statusAfter: "paused" } : result));
        }
      }
      for (const id of drafts) {
        const r = await activateDraftOffer(db, one(id), opts);
        items.push(r.ok ? itemOk(id, false, r) : itemError(id, r));
      }
    }
  } else if (action === "archive") {
    const eligible: string[] = [];
    for (const id of ids) {
      const r = await archiveOffer(db, one(id), { ...opts, dryRun: true });
      if (!r.ok) items.push(itemError(id, r));
      else eligible.push(id);
    }
    if (dryRun) for (const id of eligible) items.push(itemOk(id, true, { statusAfter: "archived" }));
    else await runBatch(eligible, items, (id) => archiveOffer(db, one(id), noPublish), publish, ctx, db, "archived");
  } else {
    // delete
    const eligible: string[] = [];
    for (const id of ids) {
      const r = await deleteOffer(db, one(id), { ...opts, dryRun: true });
      if (!r.ok) items.push(itemError(id, r));
      else {
        eligible.push(id);
        if (dryRun) items.push(itemOk(id, true, { statusBefore: r.statusBefore, statusAfter: "deleted" }));
      }
    }
    if (!dryRun) {
      const deleted: BulkItemResult[] = [];
      for (const id of eligible) {
        const r = await deleteOffer(db, one(id), { ...opts, skipPublish: true });
        deleted.push(r.ok ? itemOk(id, false, { statusBefore: r.statusBefore, statusAfter: "deleted" }) : itemError(id, r));
      }
      if (deleted.some((d) => d.ok)) {
        const failure = await publish(ctx.shopId, ctx.shopDomain);
        if (failure) {
          for (const d of deleted) {
            if (!d.ok) continue;
            d.ok = false;
            d.error = {
              code: failure.capacity ? "capacity" : "publish_failed",
              message: `Deleted, but publishing to Shopify failed (${failure.message}); the offer cannot be restored.`,
              ...(failure.capacity ? { capacity: failure.capacity } : {}),
            };
          }
        }
      }
      items.push(...deleted);
    }
  }

  const succeeded = items.filter((i) => i.ok).length;
  return { action, dryRun, items, succeeded, failed: items.length - succeeded };
}

/**
 * Runs `step` (a lifecycle call with its own publish switched off) for every eligible id, publishes once and, if that
 * publish fails, puts every changed offer back (status and archivedAt) and reports it as publish_failed.
 */
async function runBatch(
  eligible: string[],
  items: BulkItemResult[],
  step: (id: string) => Promise<OfferLifecycleResult>,
  publish: NonNullable<OfferLifecycleOptions["publish"]>,
  ctx: { shopId: string; shopDomain: string },
  db: Db,
  statusAfter: OfferStatus,
): Promise<void> {
  const done: BulkItemResult[] = [];
  const previous: Array<{ id: string; status: OfferStatus }> = [];
  for (const id of eligible) {
    const r = await step(id);
    if (r.ok) {
      previous.push({ id, status: r.statusBefore });
      done.push(itemOk(id, false, r));
    } else {
      done.push(itemError(id, r));
    }
  }
  if (previous.length > 0) {
    const failure = await publish(ctx.shopId, ctx.shopDomain);
    if (failure) {
      for (const p of previous) {
        await db
          .update(offers)
          .set({ status: p.status, ...(statusAfter === "archived" ? { archivedAt: null } : {}), updatedAt: new Date() })
          .where(and(eq(offers.shopId, ctx.shopId), eq(offers.id, p.id), eq(offers.status, statusAfter)));
      }
      const ids = new Set(previous.map((p) => p.id));
      for (const d of done) {
        if (!ids.has(d.offerId)) continue;
        d.ok = false;
        delete d.statusAfter;
        d.error = {
          code: failure.capacity ? "capacity" : "publish_failed",
          message: `Publishing to Shopify failed and the change was rolled back (${failure.message}).`,
          ...(failure.capacity ? { capacity: failure.capacity } : {}),
        };
      }
    }
  }
  items.push(...done);
}
