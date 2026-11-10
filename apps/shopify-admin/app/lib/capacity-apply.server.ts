import { capacityActions, capacityIncidents, offers, shops, type CapacityAction, type CapacityIncident, type Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import { and, eq, inArray } from "drizzle-orm";
import { insertAuditLog } from "./audit-log.server.js";
import { invalidateAutomaticBudgetCache, preflightCapacity, type CapacityOptions } from "./capacity-preflight.server.js";
import { workaroundCopy } from "./capacity-workaround-copy.js";
import type { WorkaroundKind, WorkaroundProposal, WorkaroundResult } from "./capacity-workarounds.js";
import {
  applyEdits,
  loadCatalogIndex,
  loadGiftStock,
  loadOfferRows,
  pauseEdits,
  planAllowCombine,
  planReduceGifts,
  planRequireAny,
  planWholeProducts,
  productVariantIds,
  runSplit,
  settingEdit,
  type Edit,
} from "./capacity-transforms.server.js";
import { liveIncidentOfferIds, proposeForIncident, stillBlocked, workaroundsEnabled } from "./capacity-workarounds.server.js";
import { listAutomaticDiscountCandidates, setAutomaticDiscountActive, type AutomaticDiscountCandidate } from "./discount-node.server.js";
import { FUNCTION_SHARDS_SETTING, SHARD_DOMAINS_SETTING } from "./function-shards-flag.server.js";
import { tryPublishShop, type ShopPublishFn } from "./offer-publish-flow.server.js";
import { queueProductSync } from "./sync/product-sync.server.js";
import { decryptToken } from "./token-crypto.server.js";

export const UNDO_WINDOW_MS = 24 * 3_600_000;
const MAX_EXTRA_DEACTIVATIONS = 2;

export interface ShopRef {
  id: string;
  domain: string;
}

export interface DiscountOps {
  list(shop: ShopRef): Promise<AutomaticDiscountCandidate[]>;
  setActive(shop: ShopRef, id: string, active: boolean): Promise<void>;
}

export interface ApplyDeps {
  publish?: ShopPublishFn;
  discounts?: DiscountOps;
  capacity?: CapacityOptions;
  env?: NodeJS.ProcessEnv;
  syncProducts?: (shopId: string) => Promise<unknown>;
  now?: () => Date;
}

export interface ApplyInput {
  incidentId: string;
  kind: WorkaroundKind;
  /** pause_offers: offer ids; deactivate_discounts: discount node ids. */
  selected?: string[];
  confirm: boolean;
  /** The updated_at of every offer the proposal showed, as the client received it. */
  expectedVersions: Record<string, string>;
  performedBy: string;
}

type Snapshot = {
  edits: Edit[];
  createdOfferIds: string[];
  /** updated_at of every touched offer right after Apply: Undo refuses when any of them moved since. */
  offerUpdatedAfter: Record<string, string>;
  /** Shopify discounts Apply deactivated, in order; Undo and rollback reactivate them. */
  deactivated: string[];
};

const emptySnapshot = (): Snapshot => ({ edits: [], createdOfferIds: [], offerUpdatedAfter: {}, deactivated: [] });

class Refusal extends Error {
  constructor(
    readonly result: WorkaroundResult,
  ) {
    super(result.message);
  }
}

const refuse = (code: WorkaroundResult["code"], message: string): Refusal => new Refusal({ ok: false, code, message });
const isUniqueViolation = (error: unknown) => {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || /duplicate key|unique constraint/i.test(error instanceof Error ? error.message : "");
};

async function defaultOps(db: Db): Promise<DiscountOps> {
  const token = async (shop: ShopRef) => {
    const [row] = await db.select({ token: shops.accessTokenEncrypted }).from(shops).where(eq(shops.id, shop.id)).limit(1);
    if (!row) throw new Error("Shop not found.");
    return decryptToken(row.token);
  };
  return {
    list: async (shop) => listAutomaticDiscountCandidates(shop.id, shop.domain, await token(shop)),
    setActive: async (shop, id, active) => setAutomaticDiscountActive(shop.domain, await token(shop), id, active),
  };
}

interface Plan {
  edits: Edit[];
  alreadyApplied?: boolean;
  /** Offers the preflight must count as live; defaults to the incident's own. */
  include?: string[];
  checkFit: boolean;
  deactivate?: string[];
  createdOfferIds?: string[];
}

async function buildPlan(tx: Db, incident: CapacityIncident, proposal: WorkaroundProposal, selected: string[]): Promise<Plan> {
  const { shopId } = incident;
  const offerId = String(proposal.params["offerId"] ?? "");
  switch (proposal.kind) {
    case "use_whole_products": {
      const rows = (await loadOfferRows(tx, shopId, [offerId])).get(offerId);
      if (!rows) throw refuse("stale", workaroundCopy.stale);
      const edits = planWholeProducts(rows, await loadCatalogIndex(tx, shopId, productVariantIds([rows]))).edits;
      if (edits.length === 0) throw refuse("stale", workaroundCopy.stale);
      return { edits, checkFit: true };
    }
    case "require_any": {
      const rows = (await loadOfferRows(tx, shopId, [offerId])).get(offerId);
      const edits = rows ? planRequireAny(rows).edits : [];
      if (edits.length === 0) throw refuse("stale", workaroundCopy.stale);
      return { edits, checkFit: true };
    }
    case "reduce_gift_options": {
      const rows = (await loadOfferRows(tx, shopId, [offerId])).get(offerId);
      const ids = rows?.rewards.find((reward) => reward.id === proposal.params["rewardId"]);
      const variants = ids ? ((ids.target as { variantIds?: string[] }).variantIds ?? []) : [];
      const plan = rows ? planReduceGifts(rows, await loadGiftStock(tx, shopId, variants), Number(proposal.params["keep"])) : null;
      if (!plan) throw refuse("stale", workaroundCopy.stale);
      return { edits: plan.edits, checkFit: true };
    }
    case "split_offer": {
      const rows = (await loadOfferRows(tx, shopId, [offerId])).get(offerId);
      const outcome = rows ? await runSplit(tx, shopId, rows, String(proposal.params["rewardId"]), Number(proposal.params["parts"])) : null;
      if (!outcome) throw refuse("stale", workaroundCopy.stale);
      return { edits: outcome.edits, alreadyApplied: true, include: outcome.partIds, checkFit: true, createdOfferIds: outcome.partIds };
    }
    case "pause_offers": {
      const rows = await loadOfferRows(tx, shopId, selected);
      const edits = pauseEdits(rows.values());
      if (edits.length !== selected.length) throw refuse("stale", workaroundCopy.stale);
      const paused = new Set(selected);
      return { edits, include: (await liveIncidentOfferIds(tx, incident)).filter((id) => !paused.has(id)), checkFit: true };
    }
    case "enable_combination_groups":
      return { edits: [await settingEdit(tx, shopId, SHARD_DOMAINS_SETTING, "true")], checkFit: true };
    case "enable_shards":
      return { edits: [await settingEdit(tx, shopId, FUNCTION_SHARDS_SETTING, "true")], checkFit: true };
    case "allow_combine": {
      const ids = (proposal.params["offerIds"] as string[]) ?? [];
      const edits = planAllowCombine((await loadOfferRows(tx, shopId, ids)).values());
      if (edits.length === 0) throw refuse("stale", workaroundCopy.stale);
      return { edits, checkFit: true };
    }
    case "deactivate_discounts":
      return { edits: [], checkFit: false, deactivate: selected };
    case "sync_products":
      return { edits: [], checkFit: false };
  }
}

async function updatedAtOf(tx: Db, shopId: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await tx.select({ id: offers.id, updatedAt: offers.updatedAt }).from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, ids)));
  return Object.fromEntries(rows.map((row) => [row.id, row.updatedAt.toISOString()]));
}

const touchedOffers = (edits: Edit[]) => [...new Set(edits.flatMap((edit) => (edit.table === "setting" ? [] : [edit.table === "offer" ? edit.id : edit.offerId])))];

async function setAction(db: Db, shopId: string, actionId: string, values: Partial<typeof capacityActions.$inferInsert>) {
  await db.update(capacityActions).set(values).where(and(eq(capacityActions.shopId, shopId), eq(capacityActions.id, actionId)));
}

async function audit(db: Db, shopId: string, performedBy: string, action: string, offerIds: string[], extra: Record<string, unknown>) {
  for (const offerId of offerIds) await insertAuditLog(db, { shopId, entityType: "offer", entityId: offerId, action, after: extra, performedBy });
}

async function revertAll(db: Db, shop: ShopRef, ops: () => Promise<DiscountOps>, snapshot: Snapshot): Promise<string[]> {
  const errors: string[] = [];
  for (const id of [...snapshot.deactivated].reverse()) {
    try {
      await (await ops()).setActive(shop, id, true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (snapshot.edits.length > 0) await db.transaction(async (tx) => void (await applyEdits(tx as unknown as Db, shop.id, snapshot.edits, "revert")));
  await invalidateAutomaticBudgetCache(shop.id);
  return errors;
}

export async function applyWorkaround(db: Db, shop: ShopRef, input: ApplyInput, deps: ApplyDeps = {}): Promise<WorkaroundResult> {
  const env = deps.env ?? process.env;
  if (!workaroundsEnabled(env)) return { ok: false, code: "refused", message: workaroundCopy.killSwitch };
  const [incident] = await db
    .select()
    .from(capacityIncidents)
    .where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, input.incidentId), inArray(capacityIncidents.status, ["open", "dismissed"])));
  if (!incident) return { ok: false, code: "not_found", message: workaroundCopy.notFound };

  const ops = (() => {
    let cached: Promise<DiscountOps> | undefined;
    return () => (cached ??= deps.discounts ? Promise.resolve(deps.discounts) : defaultOps(db));
  })();
  const selected = [...new Set(input.selected ?? [])];

  // The server recomputes the proposal; nothing the client says about what a fix does is trusted.
  const proposal = (await proposeForIncident(db, incident, { ...(deps.capacity ? { capacity: deps.capacity } : {}), env })).proposals.find((p) => p.kind === input.kind);
  if (!proposal) return { ok: false, code: "stale", message: workaroundCopy.stale };
  if (Object.entries(proposal.offerVersions).some(([id, iso]) => input.expectedVersions[id] !== iso)) return { ok: false, code: "stale", message: workaroundCopy.stale };
  if (proposal.semanticChange && !input.confirm) return { ok: false, code: "refused", message: "Confirm that you understand what changes for customers." };
  if (proposal.kind === "pause_offers") {
    const allowed = new Set(proposal.options?.items.map((item) => item.id));
    if (selected.length === 0 || selected.some((id) => !allowed.has(id))) return { ok: false, code: "refused", message: workaroundCopy.stale };
  }
  if (proposal.kind === "deactivate_discounts") {
    const needed = Number(proposal.params["needed"] ?? 1);
    const candidates = new Set((await (await ops()).list(shop)).map((candidate) => candidate.id));
    if (selected.length < needed) return { ok: false, code: "refused", message: `Select at least ${needed}.` };
    if (selected.length > needed + MAX_EXTRA_DEACTIVATIONS || selected.some((id) => !candidates.has(id))) return { ok: false, code: "refused", message: workaroundCopy.stale };
  }

  let action: CapacityAction | undefined;
  try {
    [action] = await db
      .insert(capacityActions)
      .values({ shopId: shop.id, incidentId: incident.id, kind: input.kind, params: { ...proposal.params, selected }, status: "pending", performedBy: input.performedBy })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "busy", message: workaroundCopy.busy };
    throw error;
  }
  if (!action) throw new Error("Could not record the capacity action.");
  const actionId = action.id;
  const snapshot = emptySnapshot();
  const fail = async (result: WorkaroundResult, status: "rolled_back" = "rolled_back") => {
    await setAction(db, shop.id, actionId, { status, error: result.message, snapshot });
    return { ...result, actionId };
  };

  try {
    const plan = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [locked] = await tx
        .select({ status: capacityIncidents.status })
        .from(capacityIncidents)
        .where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, incident.id)))
        .for("update");
      if (!locked || locked.status === "resolved") throw refuse("not_found", workaroundCopy.notFound);
      const built = await buildPlan(tx, incident, proposal, selected);
      if (!built.alreadyApplied) await applyEdits(tx, shop.id, built.edits);
      if (built.checkFit) {
        const result = await preflightCapacity(tx, shop.id, built.include ?? (await liveIncidentOfferIds(tx, incident)), deps.capacity);
        if (stillBlocked(result, incident)) throw refuse("still_blocked", workaroundCopy.stillDoesntFit(result.message));
      }
      snapshot.edits = built.edits;
      snapshot.createdOfferIds = built.createdOfferIds ?? [];
      snapshot.offerUpdatedAfter = await updatedAtOf(tx, shop.id, touchedOffers(built.edits));
      await tx.update(capacityActions).set({ snapshot }).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId)));
      return built;
    });

    if (input.kind === "sync_products") {
      await (deps.syncProducts ?? queueProductSync)(shop.id);
      await setAction(db, shop.id, actionId, { status: "applied", appliedAt: (deps.now ?? (() => new Date()))() });
      await audit(db, shop.id, input.performedBy, "capacity_workaround_applied", incident.offerIds, { kind: input.kind, incidentId: incident.id });
      return { ok: true, code: "applied", message: `${workaroundCopy.syncProducts.title}: started. Publish again once it finishes.`, actionId };
    }

    try {
      for (const id of plan.deactivate ?? []) {
        await (await ops()).setActive(shop, id, false);
        snapshot.deactivated.push(id);
        await setAction(db, shop.id, actionId, { snapshot });
      }
    } catch (error) {
      const undoErrors = await revertAll(db, shop, ops, snapshot);
      return fail({ ok: false, code: "rolled_back", message: `${error instanceof Error ? error.message : String(error)}${undoErrors.length ? ` Reactivating failed: ${undoErrors.join("; ")}` : ""}` });
    }
    if (snapshot.deactivated.length > 0 || snapshot.edits.some((edit) => edit.table === "setting")) await invalidateAutomaticBudgetCache(shop.id);

    const publish = deps.publish ?? tryPublishShop;
    const failure = await publish(shop.id, shop.domain);
    if (failure) {
      const undoErrors = await revertAll(db, shop, ops, snapshot);
      // A capacity block is raised before anything is written; any other failure may have touched the live config.
      if (!failure.capacity) await publish(shop.id, shop.domain).catch((error) => Sentry.captureException(error, { tags: { shopId: shop.id, context: "capacity-apply-republish" } }));
      return fail({ ok: false, code: "rolled_back", message: `${failure.message}${undoErrors.length ? ` Reactivating failed: ${undoErrors.join("; ")}` : ""}` });
    }

    const now = (deps.now ?? (() => new Date()))();
    await setAction(db, shop.id, actionId, { status: "applied", appliedAt: now, undoUntil: new Date(now.getTime() + UNDO_WINDOW_MS), snapshot });
    await db
      .update(capacityIncidents)
      .set({ status: "resolved", resolution: "workaround", resolvedAt: now })
      .where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, incident.id)));
    const touched = touchedOffers(snapshot.edits);
    await audit(db, shop.id, input.performedBy, "capacity_workaround_applied", touched.length > 0 ? touched : incident.offerIds, { kind: input.kind, incidentId: incident.id, actionId });
    const pending = (await db.select({ id: offers.id, name: offers.internalName, status: offers.status }).from(offers).where(and(eq(offers.shopId, shop.id), inArray(offers.id, incident.offerIds)))).filter((row) => row.status === "draft" || row.status === "paused");
    const pausedByUs = new Set(snapshot.edits.filter((edit) => edit.table === "offer" && edit.after.status === "paused").map((edit) => (edit as { id: string }).id));
    const toActivate = pending.filter((row) => !pausedByUs.has(row.id)).map((row) => ({ id: row.id, name: row.name }));
    return {
      ok: true,
      code: "applied",
      message: [workaroundCopy.appliedMessage(proposal.title), toActivate.length > 0 ? workaroundCopy.activateHint(toActivate.map((row) => row.name)) : ""].filter(Boolean).join(" "),
      actionId,
      ...(toActivate.length > 0 ? { offersToActivate: toActivate } : {}),
    };
  } catch (error) {
    if (error instanceof Refusal) return fail(error.result);
    await fail({ ok: false, code: "rolled_back", message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  }
}

const DEFINITION_KINDS = new Set<WorkaroundKind>(["use_whole_products", "require_any", "reduce_gift_options", "split_offer"]);

export async function undoWorkaround(db: Db, shop: ShopRef, actionId: string, performedBy: string, deps: ApplyDeps = {}): Promise<WorkaroundResult> {
  const now = (deps.now ?? (() => new Date()))();
  const [action] = await db.select().from(capacityActions).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId)));
  if (!action) return { ok: false, code: "not_found", message: workaroundCopy.notFound };
  if (action.status !== "applied" || action.kind === "sync_products") return { ok: false, code: "undo_refused", message: workaroundCopy.undoChangedSince };
  if (!action.undoUntil || action.undoUntil.getTime() < now.getTime()) return { ok: false, code: "undo_refused", message: workaroundCopy.undoExpired };

  const snapshot = action.snapshot as unknown as Snapshot;
  const current = await updatedAtOf(db, shop.id, Object.keys(snapshot.offerUpdatedAfter));
  const settingsMoved = await Promise.all(
    snapshot.edits.filter((edit): edit is Extract<Edit, { table: "setting" }> => edit.table === "setting").map(async (edit) => (await settingEdit(db, shop.id, edit.key, "")).before.value !== edit.after.value),
  );
  if (Object.entries(snapshot.offerUpdatedAfter).some(([id, iso]) => current[id] !== iso) || settingsMoved.some(Boolean)) {
    return { ok: false, code: "undo_refused", message: workaroundCopy.undoChangedSince, actionId };
  }

  const claim = async () => {
    try {
      return await db.update(capacityActions).set({ status: "pending" }).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId), eq(capacityActions.status, "applied"))).returning({ id: capacityActions.id });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  };
  const claimed = await claim();
  if (claimed === null) return { ok: false, code: "busy", message: workaroundCopy.busy, actionId };
  if (claimed.length === 0) return { ok: false, code: "undo_refused", message: workaroundCopy.undoChangedSince, actionId };

  const [incident] = await db.select().from(capacityIncidents).where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, action.incidentId)));
  const ops = (() => {
    let cached: Promise<DiscountOps> | undefined;
    return () => (cached ??= deps.discounts ? Promise.resolve(deps.discounts) : defaultOps(db));
  })();
  const backToApplied = (message: string, code: WorkaroundResult["code"] = "undo_refused") =>
    setAction(db, shop.id, actionId, { status: code === "undo_failed" ? "undo_failed" : "applied", ...(code === "undo_failed" ? { error: message } : {}) }).then((): WorkaroundResult => ({ ok: false, code, message, actionId }));

  const reactivated: string[] = [];
  try {
    for (const id of snapshot.deactivated) {
      await (await ops()).setActive(shop, id, true);
      reactivated.push(id);
    }
  } catch (error) {
    for (const id of reactivated) await (await ops()).setActive(shop, id, false).catch(() => undefined);
    return backToApplied(error instanceof Error ? error.message : String(error), "undo_failed");
  }
  if (reactivated.length > 0) await invalidateAutomaticBudgetCache(shop.id);

  const definition = DEFINITION_KINDS.has(action.kind as WorkaroundKind);
  const pausedOnUndo: string[] = [];
  let reopen = false;
  try {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await applyEdits(tx, shop.id, snapshot.edits, "revert");
      if (!incident) return;
      const include = (await liveIncidentOfferIds(tx, incident)).filter((id) => !snapshot.createdOfferIds.includes(id));
      const result = await preflightCapacity(tx, shop.id, include, deps.capacity);
      if (!stillBlocked(result, incident)) return;
      if (!definition) throw refuse("undo_refused", workaroundCopy.stillDoesntFit(result.message));
      // The restored definition is the one that doesn't fit: whatever of it is live goes back to paused.
      reopen = true;
      const rows = await loadOfferRows(tx, shop.id, include);
      const edits = pauseEdits(rows.values());
      await applyEdits(tx, shop.id, edits);
      pausedOnUndo.push(...edits.map((edit) => (edit as { id: string }).id));
      const live = [...rows.values()].filter((row) => row.offer.status === "active" && !pausedOnUndo.includes(row.offer.id)).map((row) => row.offer.id);
      const recheck = await preflightCapacity(tx, shop.id, live, deps.capacity);
      if (stillBlocked(recheck, incident)) throw refuse("undo_refused", workaroundCopy.stillDoesntFit(recheck.message));
    });
  } catch (error) {
    for (const id of reactivated) await (await ops()).setActive(shop, id, false).catch(() => undefined);
    if (error instanceof Refusal) return backToApplied(error.result.message);
    await backToApplied(error instanceof Error ? error.message : String(error), "undo_failed");
    throw error;
  }
  await invalidateAutomaticBudgetCache(shop.id);

  const failure = await (deps.publish ?? tryPublishShop)(shop.id, shop.domain);
  if (failure) {
    // Roll forward: put the fix back so the shop keeps the configuration that last published.
    await db.transaction(async (tx) => void (await applyEdits(tx as unknown as Db, shop.id, snapshot.edits, "apply")));
    for (const id of reactivated) await (await ops()).setActive(shop, id, false).catch(() => undefined);
    await invalidateAutomaticBudgetCache(shop.id);
    await (deps.publish ?? tryPublishShop)(shop.id, shop.domain).catch((publishError) => Sentry.captureException(publishError, { tags: { shopId: shop.id, context: "capacity-undo-republish" } }));
    return backToApplied(failure.message, "undo_failed");
  }

  await setAction(db, shop.id, actionId, { status: "undone", undoneAt: now, snapshot: { ...snapshot, pausedOnUndo } as unknown as Record<string, unknown> });
  if (reopen && incident) {
    await db
      .update(capacityIncidents)
      .set({ status: "open", resolution: null, resolvedAt: null })
      .where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, incident.id), eq(capacityIncidents.status, "resolved")))
      .catch(() => undefined);
  }
  await audit(db, shop.id, performedBy, "capacity_workaround_undone", touchedOffers(snapshot.edits), { kind: action.kind, actionId });
  return { ok: true, code: "undone", message: reopen ? `${workaroundCopy.undoneMessage} ${workaroundCopy.undoRestoresPaused}` : workaroundCopy.undoneMessage, actionId };
}
