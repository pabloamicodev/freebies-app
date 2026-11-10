import { capacityActions, capacityIncidents, offers, shops, type CapacityAction, type CapacityIncident, type Db } from "@promo/db";
import * as Sentry from "@sentry/node";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { activationStatus } from "./offer-scheduling.server.js";
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
  splitPartStatus,
  type Edit,
} from "./capacity-transforms.server.js";
import { liveIncidentOfferIds, proposeForIncident, stillBlocked, workaroundsEnabled } from "./capacity-workarounds.server.js";
import { listAutomaticDiscountCandidates, setAutomaticDiscountActive, type AutomaticDiscountCandidate } from "./discount-node.server.js";
import { tryPublishShop, tryPublishShopOutcome, type ShopPublishFn } from "./offer-publish-flow.server.js";
import { queueProductSync } from "./sync/product-sync.server.js";
import { decryptToken } from "./token-crypto.server.js";

export const UNDO_WINDOW_MS = 24 * 3_600_000;
/** An Apply or Undo that has been pending this long was killed mid-flight (the function limit is far shorter). */
export const STALE_PENDING_MS = 10 * 60_000;
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
  /** Test stand-in for the publish outcome: true when that publish was parked behind another one (lock busy). */
  isPending?: (shopId: string) => Promise<boolean>;
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
  /** Set when an Undo claims the action, so a killed Undo is told apart from a killed Apply. */
  undoStartedAt?: string;
  /** The publish was parked behind another one: the next successful publish resolves the incident. */
  publishPending?: boolean;
  /** Written the moment the publish succeeded: from then on nothing may revert the fix, only mark it applied. */
  publishedAt?: string;
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

export async function discountOps(db: Db): Promise<DiscountOps> {
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
  /** Offers the fix itself handles (the split original): never auto-activated. */
  keepOff?: string[];
}

async function buildPlan(tx: Db, incident: CapacityIncident, proposal: WorkaroundProposal, selected: string[], held: HeldCheck, now: Date): Promise<Plan> {
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
      const partStatus = rows ? splitPartStatus(rows.offer, held.activate.some((entry) => entry.id === offerId), now) : "paused";
      const outcome = rows ? await runSplit(tx, shopId, rows, String(proposal.params["rewardId"]), Number(proposal.params["parts"]), partStatus) : null;
      if (!outcome) throw refuse("stale", workaroundCopy.stale);
      return { edits: outcome.edits, alreadyApplied: true, include: outcome.partIds, checkFit: true, createdOfferIds: outcome.partIds, keepOff: [offerId] };
    }
    case "pause_offers": {
      const rows = await loadOfferRows(tx, shopId, selected);
      const edits = pauseEdits(rows.values());
      if (edits.length !== selected.length) throw refuse("stale", workaroundCopy.stale);
      const paused = new Set(selected);
      return { edits, include: (await liveIncidentOfferIds(tx, incident)).filter((id) => !paused.has(id)), checkFit: true };
    }
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

interface HeldCheck {
  /** Recorded at the block, still in the state recorded, and not already ended: safe to switch on. */
  activate: Array<{ id: string; endsAt: Date | null; startsAt: Date | null; status: "draft" | "paused" }>;
  /** Recorded at the block but draft or paused for a different reason now: changed after the block. */
  changed: Array<{ id: string; name: string; status: string }>;
}

/**
 * Only offers the blocked publish was switching on (`incident.held`) are candidates, and only while their status and
 * updatedAt are what they were when the block was recorded. Must run before the fix edits those same offers.
 */
async function checkHeldOffers(tx: Db, incident: CapacityIncident): Promise<HeldCheck> {
  const result: HeldCheck = { activate: [], changed: [] };
  if (incident.held.length === 0) return result;
  const rows = await tx
    .select({ id: offers.id, name: offers.internalName, status: offers.status, updatedAt: offers.updatedAt, startsAt: offers.startsAt, endsAt: offers.endsAt })
    .from(offers)
    .where(and(eq(offers.shopId, incident.shopId), inArray(offers.id, incident.held.map((entry) => entry.id))));
  for (const row of rows) {
    if (row.status !== "draft" && row.status !== "paused") continue;
    const entry = incident.held.find((held) => held.id === row.id);
    if (entry && entry.status === row.status && entry.updatedAt === row.updatedAt.toISOString()) result.activate.push({ id: row.id, startsAt: row.startsAt, endsAt: row.endsAt, status: row.status });
    else result.changed.push({ id: row.id, name: row.name, status: row.status });
  }
  return result;
}

/** Offers this very action paused (`pause_offers`, the split original) and the split parts are never switched on. */
function activationEdits(check: HeldCheck, planned: readonly Edit[], skip: readonly string[], now: Date): Edit[] {
  const pausedByUs = new Set([...skip, ...planned.filter((edit) => edit.table === "offer" && edit.after.status === "paused").map((edit) => (edit as { id: string }).id)]);
  const edits: Edit[] = [];
  for (const row of check.activate) {
    if (pausedByUs.has(row.id)) continue;
    const next = activationStatus(row.startsAt, row.endsAt, now);
    if (next === "expired") continue;
    edits.push({ table: "offer", id: row.id, before: { status: row.status }, after: { status: next } });
  }
  return edits;
}

const startedAtOf = (createdAt: Date, snapshot: Partial<Snapshot>) => Math.max(createdAt.getTime(), snapshot.undoStartedAt ? Date.parse(snapshot.undoStartedAt) : 0);

/**
 * A pending action older than STALE_PENDING_MS belongs to a function that died mid-flight. It is marked failed and, for
 * an Apply, its committed edits are reverted once (the claim is atomic). An Undo has nothing safe to re-run: it is
 * marked undo_failed for a human. Returns how many were reclaimed.
 */
export async function reclaimStalePending(db: Db, shop: ShopRef, deps: ApplyDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const pending = await db.select().from(capacityActions).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.status, "pending")));
  let reclaimed = 0;
  for (const action of pending) {
    const snapshot = { ...emptySnapshot(), ...(action.snapshot as Partial<Snapshot>) };
    if (now.getTime() - startedAtOf(action.createdAt, snapshot) < STALE_PENDING_MS) continue;
    const isUndo = snapshot.undoStartedAt !== undefined;
    if (!isUndo && snapshot.publishedAt) {
      // The publish succeeded and only the bookkeeping was lost: the fix is live, so it is recorded, never reverted.
      const publishedAt = new Date(snapshot.publishedAt);
      const done = await db
        .update(capacityActions)
        .set({ status: "applied", appliedAt: publishedAt, undoUntil: new Date(publishedAt.getTime() + UNDO_WINDOW_MS) })
        .where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, action.id), eq(capacityActions.status, "pending")))
        .returning({ id: capacityActions.id });
      reclaimed += done.length;
      continue;
    }
    const claimed = await db
      .update(capacityActions)
      .set({ status: isUndo ? "undo_failed" : "rolled_back", error: workaroundCopy.timedOut })
      .where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, action.id), eq(capacityActions.status, "pending")))
      .returning({ id: capacityActions.id });
    if (claimed.length === 0) continue;
    reclaimed += 1;
    Sentry.captureMessage("Stale capacity action reclaimed", { level: "warning", tags: { shopId: shop.id, kind: action.kind, context: isUndo ? "capacity-undo-timeout" : "capacity-apply-timeout" } });
    if (isUndo) continue;
    const ops = () => (deps.discounts ? Promise.resolve(deps.discounts) : discountOps(db));
    const current = await updatedAtOf(db, shop.id, Object.keys(snapshot.offerUpdatedAfter));
    if (Object.entries(snapshot.offerUpdatedAfter).some(([id, iso]) => current[id] !== iso)) {
      await setAction(db, shop.id, action.id, { error: `${workaroundCopy.timedOut} ${workaroundCopy.undoChangedSince}` });
      continue;
    }
    const errors = await revertAll(db, shop, ops, snapshot);
    if (errors.length > 0) await setAction(db, shop.id, action.id, { error: `${workaroundCopy.timedOut} Reactivating failed: ${errors.join("; ")}` });
    if (snapshot.edits.length > 0 || snapshot.deactivated.length > 0) {
      await (deps.publish ?? tryPublishShop)(shop.id, shop.domain).catch((error) => Sentry.captureException(error, { tags: { shopId: shop.id, context: "capacity-reclaim-republish" } }));
    }
  }
  return reclaimed;
}

/** Cron entry: reclaims stale pending actions across every shop. */
export async function reclaimAllStalePending(db: Db, deps: ApplyDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db
    .select({ id: shops.id, domain: shops.shopDomain, createdAt: capacityActions.createdAt, snapshot: capacityActions.snapshot })
    .from(capacityActions)
    .innerJoin(shops, eq(shops.id, capacityActions.shopId))
    .where(eq(capacityActions.status, "pending"));
  const stale = new Map<string, ShopRef>();
  for (const row of rows) {
    if (now.getTime() - startedAtOf(row.createdAt, row.snapshot as Partial<Snapshot>) >= STALE_PENDING_MS) stale.set(row.id, { id: row.id, domain: row.domain });
  }
  let total = 0;
  for (const shop of stale.values()) total += await reclaimStalePending(db, shop, deps);
  return total;
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
    return () => (cached ??= deps.discounts ? Promise.resolve(deps.discounts) : discountOps(db));
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

  await reclaimStalePending(db, shop, deps);

  let held: HeldCheck = { activate: [], changed: [] };
  let committed = false;
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
      held = await checkHeldOffers(tx, incident);
      const built = await buildPlan(tx, incident, proposal, selected, held, deps.now?.() ?? new Date());
      if (!built.alreadyApplied) await applyEdits(tx, shop.id, built.edits);
      if (built.checkFit) {
        const result = await preflightCapacity(tx, shop.id, built.include ?? (await liveIncidentOfferIds(tx, incident)), deps.capacity);
        if (stillBlocked(result, incident)) throw refuse("still_blocked", workaroundCopy.stillDoesntFit(result.message));
      }
      // Offers the block left draft or paused go live with the fix, inside the same tx, so a failed publish reverts them too.
      const activation: Edit[] = input.kind === "sync_products" ? [] : activationEdits(held, built.edits, [...(built.createdOfferIds ?? []), ...(built.keepOff ?? [])], deps.now?.() ?? new Date());
      await applyEdits(tx, shop.id, activation);
      snapshot.edits = [...built.edits, ...activation];
      snapshot.createdOfferIds = built.createdOfferIds ?? [];
      snapshot.offerUpdatedAfter = await updatedAtOf(tx, shop.id, touchedOffers(snapshot.edits));
      await tx.update(capacityActions).set({ snapshot }).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId)));
      return built;
    });
    committed = true;

    if (input.kind === "sync_products") {
      await (deps.syncProducts ?? queueProductSync)(shop.id);
      await setAction(db, shop.id, actionId, { status: "applied", appliedAt: (deps.now ?? (() => new Date()))() });
      await audit(db, shop.id, input.performedBy, "capacity_workaround_applied", incident.offerIds, { kind: input.kind, incidentId: incident.id });
      return { ok: true, code: "applied", message: `${workaroundCopy.syncProducts.title}: started. Publish again once it finishes.`, actionId };
    }

    // From here on the tx is committed: anything that fails before a successful publish must undo it all.
    const publish: ShopPublishFn = deps.publish ?? (async (id, domain) => (await tryPublishShopOutcome(id, domain)).failure);
    let publishAttempted = false;
    let parkedByThisPublish = false;
    const rollBack = async (message: string): Promise<WorkaroundResult> => {
      const undoErrors = await revertAll(db, shop, ops, snapshot);
      // A capacity block is raised before anything is written; any other failure may have touched the live config.
      if (publishAttempted) await publish(shop.id, shop.domain).catch((error) => Sentry.captureException(error, { tags: { shopId: shop.id, context: "capacity-apply-republish" } }));
      return fail({ ok: false, code: "rolled_back", message: `${message}${undoErrors.length ? ` Reactivating failed: ${undoErrors.join("; ")}` : ""}` });
    };
    let failure: Awaited<ReturnType<ShopPublishFn>>;
    try {
      for (const id of plan.deactivate ?? []) {
        await (await ops()).setActive(shop, id, false);
        snapshot.deactivated.push(id);
        await setAction(db, shop.id, actionId, { snapshot });
      }
      if (snapshot.deactivated.length > 0 || snapshot.edits.some((edit) => edit.table === "setting")) await invalidateAutomaticBudgetCache(shop.id);
      publishAttempted = true;
      if (deps.publish) failure = await deps.publish(shop.id, shop.domain);
      else {
        const outcome = await tryPublishShopOutcome(shop.id, shop.domain);
        failure = outcome.failure;
        parkedByThisPublish = outcome.parked;
      }
    } catch (error) {
      return await rollBack(error instanceof Error ? error.message : String(error));
    }
    if (failure) {
      publishAttempted = !failure.capacity;
      return await rollBack(failure.message);
    }

    // Published: the fix is live. Nothing below may undo it or mark it failed; bookkeeping is best-effort.
    const now = (deps.now ?? (() => new Date()))();
    const safely = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        Sentry.captureException(error, { tags: { shopId: shop.id, context: `capacity-apply-${label}` } });
        return fallback;
      }
    };
    snapshot.publishedAt = now.toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
      const marked = await safely("mark-published", async () => (await db.update(capacityActions).set({ snapshot: sql`${capacityActions.snapshot} || ${JSON.stringify({ publishedAt: snapshot.publishedAt })}::jsonb` }).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId))), true), false);
      if (marked) break;
    }
    const parked = parkedByThisPublish || (deps.isPending ? await safely("pending-check", () => deps.isPending!(shop.id), false) : false);
    if (parked) snapshot.publishPending = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await safely(
        "mark-applied",
        async () => {
          await setAction(db, shop.id, actionId, { status: "applied", appliedAt: now, undoUntil: new Date(now.getTime() + UNDO_WINDOW_MS), snapshot });
          return true;
        },
        false,
      );
      if (saved) break;
    }
    if (!parked) {
      await safely("resolve", () => db.update(capacityIncidents).set({ status: "resolved", resolution: "workaround", resolvedAt: now }).where(and(eq(capacityIncidents.shopId, shop.id), eq(capacityIncidents.id, incident.id))), undefined);
    }
    const touched = touchedOffers(snapshot.edits);
    await safely("audit", () => audit(db, shop.id, input.performedBy, "capacity_workaround_applied", touched.length > 0 ? touched : incident.offerIds, { kind: input.kind, incidentId: incident.id, actionId }), undefined);
    const activatedIds = snapshot.edits.filter((edit) => edit.table === "offer" && edit.after.status !== "paused" && edit.before.status !== "archived").map((edit) => (edit as { id: string }).id);
    const activated = activatedIds.length === 0 ? [] : await safely("activated-names", () => db.select({ id: offers.id, name: offers.internalName }).from(offers).where(and(eq(offers.shopId, shop.id), inArray(offers.id, activatedIds))), []);
    const keptOff = held.changed;
    return {
      ok: true,
      code: "applied",
      message: [
        parked ? workaroundCopy.appliedPendingMessage(proposal.title) : workaroundCopy.appliedMessage(proposal.title),
        activated.length > 0 ? workaroundCopy.activatedMessage(activated.map((row) => row.name)) : "",
        keptOff.length > 0 ? workaroundCopy.keptOffMessage(keptOff) : "",
      ]
        .filter(Boolean)
        .join(" "),
      actionId,
      ...(activated.length > 0 ? { activatedOffers: activated } : {}),
      ...(keptOff.length > 0 ? { keptOffOffers: keptOff } : {}),
    };
  } catch (error) {
    if (error instanceof Refusal) return fail(error.result);
    if (committed) {
      // The revert itself failed. Close the action now (a later automatic revert could not know what ran) and say so.
      Sentry.captureException(error, { tags: { shopId: shop.id, context: "capacity-apply-post-commit" } });
      await setAction(db, shop.id, actionId, { status: "undo_failed", error: `${workaroundCopy.revertFailed} ${error instanceof Error ? error.message : String(error)}`, snapshot }).catch(() => undefined);
      return { ok: false, code: "undo_failed", message: workaroundCopy.revertFailed, actionId };
    }
    await fail({ ok: false, code: "rolled_back", message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  }
}

/**
 * Runs when a shop's catalog sync finishes. A "Sync products" workaround only queued that sync, so this is the other
 * half: re-evaluate the incident with the fresh catalog and, if it now fits, switch on what the block held back and
 * republish. Idempotent (the claim marks the action), and any failure rolls its own edits back and leaves the incident open.
 */
export async function followUpSyncWorkaround(db: Db, shopId: string, deps: ApplyDeps = {}): Promise<"resolved" | "still_blocked" | "failed" | "none"> {
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await db
    .update(capacityActions)
    .set({ snapshot: sql`${capacityActions.snapshot} || '{"followedUp":true}'::jsonb` })
    .where(
      and(
        eq(capacityActions.shopId, shopId),
        eq(capacityActions.kind, "sync_products"),
        eq(capacityActions.status, "applied"),
        gt(capacityActions.appliedAt, new Date(now.getTime() - UNDO_WINDOW_MS)),
        sql`not (${capacityActions.snapshot} ? 'followedUp')`,
      ),
    )
    .returning({ incidentId: capacityActions.incidentId, performedBy: capacityActions.performedBy });
  if (claimed.length === 0) return "none";
  const [shop] = await db.select({ id: shops.id, domain: shops.shopDomain }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (!shop) return "none";
  let outcome: "resolved" | "still_blocked" | "failed" = "still_blocked";
  for (const { incidentId, performedBy } of claimed) {
    const [incident] = await db
      .select()
      .from(capacityIncidents)
      .where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.id, incidentId), inArray(capacityIncidents.status, ["open", "dismissed"])));
    if (!incident) continue;
    const result = await preflightCapacity(db, shopId, await liveIncidentOfferIds(db, incident), deps.capacity);
    if (stillBlocked(result, incident)) continue;
    const activation = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const edits = activationEdits(await checkHeldOffers(tx, incident), [], [], now);
      await applyEdits(tx, shopId, edits);
      return edits;
    });
    const failure = await (deps.publish ?? tryPublishShop)(shopId, shop.domain);
    if (failure) {
      await db.transaction(async (tx) => void (await applyEdits(tx as unknown as Db, shopId, activation, "revert")));
      if (!failure.capacity) await (deps.publish ?? tryPublishShop)(shopId, shop.domain).catch((error) => Sentry.captureException(error, { tags: { shopId, context: "capacity-sync-followup-republish" } }));
      outcome = "failed";
      continue;
    }
    await db
      .update(capacityIncidents)
      .set({ status: "resolved", resolution: "published", resolvedAt: now })
      .where(and(eq(capacityIncidents.shopId, shopId), eq(capacityIncidents.id, incident.id), inArray(capacityIncidents.status, ["open", "dismissed"])));
    await audit(db, shopId, performedBy, "capacity_sync_followup", touchedOffers(activation).length > 0 ? touchedOffers(activation) : incident.offerIds, { incidentId: incident.id });
    outcome = "resolved";
  }
  return outcome;
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
      return await db.update(capacityActions).set({ status: "pending", snapshot: { ...snapshot, undoStartedAt: now.toISOString() } as unknown as Record<string, unknown> }).where(and(eq(capacityActions.shopId, shop.id), eq(capacityActions.id, actionId), eq(capacityActions.status, "applied"))).returning({ id: capacityActions.id });
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
    return () => (cached ??= deps.discounts ? Promise.resolve(deps.discounts) : discountOps(db));
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
  let undoPauseEdits: Edit[] = [];
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
      undoPauseEdits = edits;
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
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await applyEdits(tx, shop.id, undoPauseEdits, "revert");
      await applyEdits(tx, shop.id, snapshot.edits, "apply");
    });
    for (const id of reactivated) await (await ops()).setActive(shop, id, false).catch(() => undefined);
    await invalidateAutomaticBudgetCache(shop.id);
    await (deps.publish ?? tryPublishShop)(shop.id, shop.domain).catch((publishError) => Sentry.captureException(publishError, { tags: { shopId: shop.id, context: "capacity-undo-republish" } }));
    // The fix is fully back, so the action stays applied and can be undone again.
    await setAction(db, shop.id, actionId, { status: "applied", error: failure.message });
    return { ok: false, code: "undo_failed", message: failure.message, actionId };
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
