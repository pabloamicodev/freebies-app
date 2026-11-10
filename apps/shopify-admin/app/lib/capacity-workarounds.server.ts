import { appSettings, offers, shops, type CapacityIncident, type Db } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { buildCapacityModalData } from "./capacity-capture.server.js";
import { preflightCapacity, type CapacityFailure, type CapacityOptions } from "./capacity-preflight.server.js";
import { SPLIT_REFUSAL_COPY, describeCapacityModal, isCapacityModalCode } from "./capacity-modal-copy.js";
import { confirmSemanticChangeLabel, workaroundCopy } from "./capacity-workaround-copy.js";
import type { IncidentProposals, WorkaroundOption, WorkaroundProposal } from "./capacity-workarounds.js";
import {
  applyEdits,
  largestGiftReward,
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
  type OfferRows,
} from "./capacity-transforms.server.js";
import { FUNCTION_SHARDS_SETTING, SHARD_DOMAINS_SETTING } from "./function-shards-flag.server.js";
import { SLOT_LIMITS } from "./sync/shard-planner.js";
import { splitEligibility } from "./sync/slice-offer-definition.js";

export { confirmSemanticChangeLabel };

export const workaroundsEnabled = (env: NodeJS.ProcessEnv = process.env) => env["CAPACITY_WORKAROUNDS"] !== "off";

export interface ProposalContext {
  /** Test and diagnostics overrides for the preflight (budget reader, flags). */
  capacity?: CapacityOptions;
  env?: NodeJS.ProcessEnv;
}

class Rollback extends Error {}

/** Offer ids of an incident that still exist and are not archived or expired (archived ones would be compiled as live). */
export async function liveIncidentOfferIds(db: Db, incident: Pick<CapacityIncident, "shopId" | "offerIds">): Promise<string[]> {
  if (incident.offerIds.length === 0) return [];
  const rows = await db
    .select({ id: offers.id, status: offers.status })
    .from(offers)
    .where(and(eq(offers.shopId, incident.shopId), inArray(offers.id, incident.offerIds)));
  return rows.filter((row) => row.status !== "archived" && row.status !== "expired").map((row) => row.id);
}

/** True when the preflight still reports the incident's own problem: the same code, or a block on one of its offers. */
export function stillBlocked(result: Awaited<ReturnType<typeof preflightCapacity>>, incident: Pick<CapacityIncident, "code" | "offerIds">): result is CapacityFailure {
  if (result.ok) return false;
  return result.code === incident.code || result.offerIds.some((id) => incident.offerIds.includes(id));
}

/**
 * Applies `mutate` in a transaction that always rolls back, plans the shop as the publisher would and reports
 * whether the incident's block is gone. `mutate` returns the offers the preflight must count as live.
 */
export async function fitsAfter(
  db: Db,
  incident: Pick<CapacityIncident, "shopId" | "code" | "offerIds">,
  mutate: (tx: Db) => Promise<string[] | void>,
  capacity?: CapacityOptions,
): Promise<{ fits: boolean; blocked: CapacityFailure | null }> {
  let outcome: { fits: boolean; blocked: CapacityFailure | null } = { fits: false, blocked: null };
  try {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const include = (await mutate(tx)) ?? (await liveIncidentOfferIds(tx, incident));
      const result = await preflightCapacity(tx, incident.shopId, include, capacity);
      const blocked = stillBlocked(result, incident) ? result : null;
      outcome = { fits: blocked === null, blocked };
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return outcome;
}

const versions = (rows: Iterable<OfferRows>) => Object.fromEntries([...rows].map((row) => [row.offer.id, row.offer.updatedAt.toISOString()]));
const mutation = (shopId: string, edits: Edit[]) => async (tx: Db): Promise<void> => {
  await applyEdits(tx, shopId, edits);
};

interface Scope {
  db: Db;
  incident: CapacityIncident;
  ctx: ProposalContext;
  rows: Map<string, OfferRows>;
  liveIds: string[];
}

const PRODUCT_TARGET_REASONS = new Set(["AGGREGATING_REWARD", "CART_WIDE_CAP", "MIXED_TARGETS", "STILL_TOO_LARGE", "lists", "bytes"]);
const ALL_OF_REASONS = new Set(["ALL_OF_CONDITION", "REQUIRED_IDS"]);
const GIFT_REASONS = new Set(["GIFT_PICKER", "lists", "bytes"]);

async function useWholeProducts(scope: Scope, rows: OfferRows): Promise<WorkaroundProposal | null> {
  const catalog = await loadCatalogIndex(scope.db, scope.incident.shopId, productVariantIds([rows]));
  const { edits } = planWholeProducts(rows, catalog);
  if (edits.length === 0) return null;
  const { fits } = await fitsAfter(scope.db, scope.incident, mutation(scope.incident.shopId, edits), scope.ctx.capacity);
  if (!fits) return null;
  const copy = workaroundCopy.useWholeProducts;
  return { kind: "use_whole_products", title: copy.title, summary: copy.summary, customerChange: copy.customerChange, semanticChange: false, offerVersions: versions([rows]), params: { offerId: rows.offer.id } };
}

async function requireAny(scope: Scope, rows: OfferRows): Promise<WorkaroundProposal | null> {
  const { edits, items } = planRequireAny(rows);
  if (edits.length === 0) return null;
  const { fits } = await fitsAfter(scope.db, scope.incident, mutation(scope.incident.shopId, edits), scope.ctx.capacity);
  if (!fits) return null;
  const copy = workaroundCopy.requireAny;
  return { kind: "require_any", title: copy.title, summary: copy.summary(items), customerChange: copy.customerChange(items), semanticChange: true, offerVersions: versions([rows]), params: { offerId: rows.offer.id } };
}

/** Largest number of gift options that still fits, found by bisection on the real preflight. */
async function reduceGifts(scope: Scope, rows: OfferRows): Promise<WorkaroundProposal | null> {
  const best = largestGiftReward(rows);
  if (!best) return null;
  const stock = await loadGiftStock(scope.db, scope.incident.shopId, best.variantIds);
  const fitsWith = async (keep: number) => {
    const plan = planReduceGifts(rows, stock, keep);
    if (!plan) return false;
    return (await fitsAfter(scope.db, scope.incident, mutation(scope.incident.shopId, plan.edits), scope.ctx.capacity)).fits;
  };
  let low = 1;
  let high = Math.min(best.variantIds.length - 1, Math.max(1, 100 - best.fallback));
  if (!(await fitsWith(low))) return null;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (await fitsWith(mid)) low = mid;
    else high = mid - 1;
  }
  const plan = planReduceGifts(rows, stock, low)!;
  const copy = workaroundCopy.reduceGiftOptions;
  const removedNames = plan.removed.map((id) => stock.get(id)?.title ?? id);
  return {
    kind: "reduce_gift_options",
    title: copy.title,
    summary: copy.summary(low, best.variantIds.length),
    customerChange: copy.customerChange(low, best.variantIds.length, removedNames),
    semanticChange: true,
    offerVersions: versions([rows]),
    params: { offerId: rows.offer.id, rewardId: best.reward.id, keep: low },
    note: copy.note,
  };
}

async function splitOffer(scope: Scope, rows: OfferRows): Promise<WorkaroundProposal | null> {
  const eligible = splitEligibility({ offer: rows.offer, rewards: rows.rewards, conditions: rows.conditions, policy: rows.policy });
  if (!eligible.ok) return null;
  const target = eligible.reward.target as { productIds?: unknown[]; variantIds?: unknown[] };
  const items = (target.productIds?.length ?? 0) + (target.variantIds?.length ?? 0);
  const start = Math.max(2, Math.ceil((scope.incident.numbers["bytes"] ?? 0) / (scope.incident.numbers["slotBytes"] ?? SLOT_LIMITS.slotBytes)));
  for (let k = start; k <= Math.min(start + 3, items); k++) {
    const { fits } = await fitsAfter(
      scope.db,
      scope.incident,
      async (tx) => (await runSplit(tx, scope.incident.shopId, rows, eligible.reward.id, k))?.partIds ?? [],
      scope.ctx.capacity,
    );
    if (fits) {
      const copy = workaroundCopy.splitOffer;
      return { kind: "split_offer", title: copy.title, summary: copy.summary(k), customerChange: copy.customerChange, semanticChange: true, offerVersions: versions([rows]), params: { offerId: rows.offer.id, rewardId: eligible.reward.id, parts: k }, note: copy.note };
    }
  }
  return null;
}

async function offerTooLarge(scope: Scope): Promise<{ proposals: WorkaroundProposal[]; guidance: string | null }> {
  const { incident } = scope;
  const rows = scope.rows.get(incident.offerIds[0] ?? "");
  const reason = incident.reason ?? "";
  const proposals: WorkaroundProposal[] = [];
  let guidance: string | null = null;
  if (!rows) return { proposals, guidance };
  if (reason === "VARIANT_PRODUCT_UNKNOWN") {
    const copy = workaroundCopy.syncProducts;
    proposals.push({ kind: "sync_products", title: copy.title, summary: copy.summary, customerChange: copy.customerChange, semanticChange: false, offerVersions: versions([rows]), params: { offerId: rows.offer.id }, note: copy.note });
    return { proposals, guidance };
  }
  const push = (proposal: WorkaroundProposal | null) => void (proposal && proposals.push(proposal));
  if (PRODUCT_TARGET_REASONS.has(reason)) push(await useWholeProducts(scope, rows));
  if (ALL_OF_REASONS.has(reason) || reason === "lists" || reason === "bytes") push(await requireAny(scope, rows));
  if (reason === "AGGREGATING_REWARD") push(await splitOffer(scope, rows));
  if (GIFT_REASONS.has(reason)) push(await reduceGifts(scope, rows));
  if (ALL_OF_REASONS.has(reason) && !proposals.some((proposal) => proposal.kind === "require_any")) {
    const items = Math.max(0, ...rows.conditions.filter((c) => c.conditionType === "specific_product").map((c) => (Array.isArray((c.value as { requirements?: unknown[] }).requirements) ? (c.value as { requirements: unknown[] }).requirements.length : 0)));
    guidance = workaroundCopy.requireAnyManual(items);
  }
  return { proposals, guidance };
}

/** Lowest priority first (the larger number), newest first among equals. */
const pauseOrder = (a: OfferRows, b: OfferRows) => b.offer.priority - a.offer.priority || b.offer.createdAt.getTime() - a.offer.createdAt.getTime();

/** Smallest prefix of `candidates` (lowest priority first) whose pausing makes the incident fit, by bisection on the preflight. */
export async function minimalPauseSet(scope: Pick<Scope, "db" | "incident" | "ctx">, candidates: OfferRows[]): Promise<OfferRows[] | null> {
  const sorted = candidates.filter((row) => row.offer.status === "active").sort(pauseOrder);
  const fitsPausing = async (count: number) => {
    const paused = sorted.slice(0, count);
    const pausedIds = new Set(paused.map((row) => row.offer.id));
    return (
      await fitsAfter(
        scope.db,
        scope.incident,
        async (tx) => {
          await applyEdits(tx, scope.incident.shopId, pauseEdits(paused));
          return (await liveIncidentOfferIds(tx, scope.incident)).filter((id) => !pausedIds.has(id));
        },
        scope.ctx.capacity,
      )
    ).fits;
  };
  if (sorted.length === 0 || !(await fitsPausing(sorted.length))) return null;
  let low = 1;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await fitsPausing(mid)) high = mid;
    else low = mid + 1;
  }
  return sorted.slice(0, low);
}

async function pauseProposal(scope: Scope, candidateIds: string[] | "all"): Promise<WorkaroundProposal | null> {
  const ids =
    candidateIds === "all"
      ? (await scope.db.select({ id: offers.id }).from(offers).where(and(eq(offers.shopId, scope.incident.shopId), eq(offers.status, "active")))).map((row) => row.id)
      : candidateIds;
  const rows = await loadOfferRows(scope.db, scope.incident.shopId, ids);
  const minimal = await minimalPauseSet(scope, [...rows.values()]);
  if (!minimal) return null;
  const chosen = new Set(minimal.map((row) => row.offer.id));
  const items: WorkaroundOption[] = [...rows.values()]
    .filter((row) => row.offer.status === "active")
    .sort(pauseOrder)
    .map((row) => ({ id: row.offer.id, label: row.offer.internalName, checked: chosen.has(row.offer.id) }));
  const copy = workaroundCopy.pauseOffers;
  return {
    kind: "pause_offers",
    title: copy.title,
    summary: copy.summary,
    customerChange: copy.customerChange(minimal.map((row) => row.offer.internalName)),
    semanticChange: true,
    offerVersions: versions(rows.values()),
    params: {},
    options: { label: copy.optionsLabel, items, minSelected: 1 },
    note: copy.note,
  };
}

async function automaticProposals(scope: Scope): Promise<{ proposals: WorkaroundProposal[]; guidance: string | null }> {
  const { incident } = scope;
  if (incident.code === "AUTOMATIC_DISCOUNT_LIMIT" && incident.numbers["storeActive"] === undefined) {
    return { proposals: [], guidance: workaroundCopy.tryAgainInAMinute };
  }
  const proposals: WorkaroundProposal[] = [];
  const needed = Math.max(1, incident.numbers["needed"] ?? 1);
  const copy = workaroundCopy.deactivateDiscounts;
  proposals.push({
    kind: "deactivate_discounts",
    title: copy.title,
    summary: copy.summary,
    customerChange: copy.customerChangeUnselected,
    semanticChange: true,
    offerVersions: versions(scope.rows.values()),
    params: { needed },
    options: { label: copy.optionsLabel, items: [], minSelected: needed, lazy: true },
    note: copy.note,
  });
  const pause = await pauseProposal(scope, "all");
  if (pause) proposals.push(pause);
  return { proposals, guidance: null };
}

async function combination(scope: Scope): Promise<{ proposals: WorkaroundProposal[]; guidance: string | null }> {
  const { incident, db } = scope;
  const proposals: WorkaroundProposal[] = [];
  if ((scope.ctx.env ?? process.env)["FUNCTION_SHARD_DOMAINS"] !== "off") {
    const edit = await settingEdit(db, incident.shopId, SHARD_DOMAINS_SETTING, "true");
    if ((await fitsAfter(db, incident, mutation(incident.shopId, [edit]), scope.ctx.capacity)).fits) {
      const copy = workaroundCopy.enableCombinationGroups;
      proposals.push({ kind: "enable_combination_groups", title: copy.title, summary: copy.summary, customerChange: copy.customerChange, semanticChange: true, offerVersions: {}, params: {} });
    }
  }
  const edits = planAllowCombine(scope.rows.values());
  if (edits.length > 0 && (await fitsAfter(db, incident, mutation(incident.shopId, edits), scope.ctx.capacity)).fits) {
    const copy = workaroundCopy.allowCombine;
    proposals.push({ kind: "allow_combine", title: copy.title, summary: copy.summary, customerChange: copy.customerChange, semanticChange: true, offerVersions: versions(scope.rows.values()), params: { offerIds: [...scope.rows.keys()] } });
  }
  return { proposals, guidance: null };
}

async function slotFull(scope: Scope): Promise<{ proposals: WorkaroundProposal[]; guidance: string | null }> {
  const { incident, db } = scope;
  const [flag] = await db.select({ value: appSettings.value }).from(appSettings).where(and(eq(appSettings.shopId, incident.shopId), eq(appSettings.key, FUNCTION_SHARDS_SETTING)));
  if (flag?.value === "false") {
    const edit = await settingEdit(db, incident.shopId, FUNCTION_SHARDS_SETTING, "true");
    if ((await fitsAfter(db, incident, mutation(incident.shopId, [edit]), scope.ctx.capacity)).fits) {
      const copy = workaroundCopy.enableShards;
      return { proposals: [{ kind: "enable_shards", title: copy.title, summary: copy.summary, customerChange: copy.customerChange, semanticChange: false, offerVersions: {}, params: {} }], guidance: null };
    }
    const pause = await pauseProposal(scope, "all");
    return { proposals: pause ? [pause] : [], guidance: null };
  }
  return automaticProposals(scope);
}

export async function proposeForIncident(db: Db, incident: CapacityIncident, ctx: ProposalContext = {}): Promise<IncidentProposals> {
  const rows = await loadOfferRows(db, incident.shopId, incident.offerIds);
  const liveIds = [...rows.values()].filter((row) => row.offer.status !== "archived" && row.offer.status !== "expired").map((row) => row.offer.id);
  const scope: Scope = { db, incident, ctx, rows, liveIds };
  const splitRefusal = incident.reason && incident.reason in SPLIT_REFUSAL_COPY ? incident.reason : undefined;
  const data = isCapacityModalCode(incident.code)
    ? await buildCapacityModalData(db, { shopId: incident.shopId, code: incident.code, offerIds: incident.offerIds, numbers: incident.numbers, ...(splitRefusal ? { splitRefusal } : {}) })
    : null;
  const copy = data ? describeCapacityModal(data) : { title: "Shopify limit reached", limit: "", body: "", fix: "", actions: [] };

  let result: { proposals: WorkaroundProposal[]; guidance: string | null } = { proposals: [], guidance: null };
  if (!workaroundsEnabled(ctx.env)) result = { proposals: [], guidance: workaroundCopy.killSwitch };
  else {
    switch (incident.code) {
      case "OFFER_TOO_LARGE":
        result = await offerTooLarge(scope);
        break;
      case "GROUP_TOO_LARGE":
      case "SLOT0_GROUP_TOO_LARGE": {
        // Slot 0 also holds the lower-priority tail the stop offer drags in, and pausing any of it frees the room.
        const pause = await pauseProposal(scope, incident.code === "SLOT0_GROUP_TOO_LARGE" ? "all" : incident.offerIds);
        result = { proposals: pause ? [pause] : [], guidance: null };
        break;
      }
      case "AUTOMATIC_DISCOUNT_LIMIT":
        result = await automaticProposals(scope);
        break;
      case "SLOT_FULL":
        result = await slotFull(scope);
        break;
      case "COMBINATION_SINGLE_SHARD":
        result = await combination(scope);
        break;
    }
  }
  return {
    incidentId: incident.id,
    code: incident.code,
    reason: incident.reason,
    status: incident.status === "dismissed" ? "dismissed" : "open",
    occurrences: incident.occurrences,
    lastSeenAt: incident.lastSeenAt.toISOString(),
    source: incident.source,
    offers: incident.offerIds.map((id) => ({ id, name: rows.get(id)?.offer.internalName ?? id, status: rows.get(id)?.offer.status ?? "deleted" })),
    title: copy.title,
    limit: copy.limit,
    body: copy.body,
    fix: copy.fix,
    proposals: result.proposals,
    guidance: result.guidance,
    actions: copy.actions.map((action) => ({ label: action.label, ...(action.kind === "external" ? { href: action.href } : { to: action.to }) })),
  };
}

export async function shopDomainOf(db: Db, shopId: string): Promise<string | null> {
  const [row] = await db.select({ domain: shops.myshopifyDomain }).from(shops).where(eq(shops.id, shopId));
  return row?.domain ?? null;
}

export type { Edit };
