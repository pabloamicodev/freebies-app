import { and, asc, eq } from "drizzle-orm";
import { capacityIncidents, offerCombinationPolicies, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { validateConditionValue, validateRewardPayload } from "@promo/shared-types";
import { insertAuditLog } from "./audit-log.server.js";
import { buildCapacityModalData } from "./capacity-capture.server.js";
import { describeCapacityModal } from "./capacity-modal-copy.js";
import { preflightCapacity } from "./capacity-preflight.server.js";
import { proposeForIncident } from "./capacity-workarounds.server.js";
import type { OfferStatus } from "./offer-scheduling.server.js";
import { statusForScheduleSave } from "./offer-scheduling.server.js";
import { statusFor } from "./offer-authoring/offer.js";
import type { AuthoringDeps, StoredCombinationPolicy, StoredCondition, StoredReward, WriteServiceOptions } from "./offer-authoring/types.js";
import {
  finalizeCreatedOffer,
  republishIfActive,
  validateActivationWithPreflight,
  validateOffersPublishable,
  type CapacityDetails,
} from "./offer-publish-flow.server.js";
import { isUniqueViolation, withUniqueOfferSuffix } from "./unique-offer-name.server.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What the admin capacity modal shows, for a tool/agent: the limit, the numbers and the guided workarounds. */
export type CapacityBlock = CapacityDetails & {
  message: string;
  limit?: string;
  fix?: string;
  incidentId?: string;
  workarounds?: Array<{ kind: string; title: string; summary: string; customerChange: string; semanticChange: boolean }>;
};

export type OfferGraphFailure = {
  ok: false;
  code: "validation" | "not_found" | "state" | "publish_failed";
  error: string;
  path?: string;
  reason?: "stale";
  /** The offer exists (saved, possibly as a draft) even though the call failed. */
  offerId?: string;
  status?: OfferStatus;
  capacity?: CapacityBlock;
};

export type OfferGraphSuccess = {
  ok: true;
  dryRun: boolean;
  /** Null on a dry run of a create. */
  offerId: string | null;
  status: OfferStatus;
  statusBefore?: OfferStatus;
  updatedAt: Date | null;
  /** Dry run only: the name the offer would get (made unique when taken). */
  internalName?: string;
  warnings?: string[];
};

export type OfferGraphResult = OfferGraphSuccess | OfferGraphFailure;

/** A hook (code creation, bundle extras) throws this to refuse the whole create with a message. */
export class OfferGraphRejection extends Error {}

export type AfterInsertHook = (tx: Tx, offerId: string) => Promise<void>;

export type OfferFields = {
  type: "discount" | "gift" | "bundle" | "upsell" | "shipping" | "booster";
  internalName: string;
  publicTitle: string;
  cartLabels: string[];
  description?: string | null;
  priority?: number;
  startsAt: Date | null;
  endsAt: Date | null;
  tierMode?: "cumulative" | "highest" | null;
  requiresCode?: boolean;
};

export type CreateOfferGraphInput = {
  offer: OfferFields;
  /** draft stays draft; active becomes scheduled for a future start. */
  status: "draft" | "active";
  conditions: StoredCondition[];
  rewards: StoredReward[];
  policy: StoredCombinationPolicy;
  afterInsert?: AfterInsertHook[];
};

export type UpdateOfferGraphPatch = {
  offer?: Partial<Omit<OfferFields, "type" | "requiresCode">>;
  /** Replaces every condition of the offer. */
  conditions?: StoredCondition[];
  /** Replaces every reward of the offer. */
  rewards?: StoredReward[];
};

/** Defaults of the wizards' combination step (all three "combines with" switches start on). */
export const WIZARD_POLICY_DEFAULTS = {
  combinesWithOrderDiscounts: true,
  combinesWithProductDiscounts: true,
  combinesWithShippingDiscounts: true,
  combinesWithOtherAppOffers: true,
  stopLowerPriority: false,
  canStackWithGiftOffers: true,
  giftValueCountsForOtherOffers: false,
  maxApplicationsPerCart: null,
  maxApplicationsPerCustomer: null,
  requireIdentifiedCustomer: false,
} satisfies Required<StoredCombinationPolicy>;

const fail = (code: OfferGraphFailure["code"], error: string, extra: Partial<OfferGraphFailure> = {}): OfferGraphFailure => ({ ok: false, code, error, ...extra });

class DryRunRollback extends Error {
  constructor(readonly outcome: OfferGraphResult) {
    super("dry run rollback");
  }
}

function validateRows(conditions: readonly StoredCondition[], rewards: readonly StoredReward[]): OfferGraphFailure | null {
  for (const [index, condition] of conditions.entries()) {
    const valid = validateConditionValue(condition.conditionType, condition.value);
    if (!valid.success) return fail("validation", `conditions[${index}] (${condition.conditionType}): ${valid.error.issues[0]?.message ?? "invalid value"}`, { path: `conditions[${index}]` });
  }
  for (const [index, reward] of rewards.entries()) {
    const valid = validateRewardPayload(reward.rewardType, reward.discountType, reward.value, reward.target);
    if (!valid.success) return fail("validation", `rewards[${index}] (${reward.rewardType}): ${valid.error.issues[0]?.message ?? "invalid reward"}`, { path: `rewards[${index}]` });
  }
  return null;
}

async function insertConditions(tx: Tx, shopId: string, offerId: string, conditions: readonly StoredCondition[]): Promise<void> {
  for (const [index, condition] of conditions.entries()) {
    await tx.insert(offerConditions).values({
      shopId,
      offerId,
      scope: condition.scope,
      conditionType: condition.conditionType,
      operator: condition.operator,
      value: condition.value,
      sortOrder: condition.sortOrder ?? index,
      isEnabled: condition.isEnabled ?? true,
    });
  }
}

async function insertRewards(tx: Tx, shopId: string, offerId: string, rewards: readonly StoredReward[]): Promise<void> {
  for (const [index, reward] of rewards.entries()) {
    await tx.insert(offerRewards).values({
      shopId,
      offerId,
      rewardType: reward.rewardType,
      discountType: reward.discountType,
      value: reward.value,
      target: reward.target,
      quantity: reward.quantity ?? null,
      isAutoAdd: reward.isAutoAdd ?? false,
      isCustomerSelectable: reward.isCustomerSelectable ?? false,
      trackMode: reward.trackMode ?? "product",
      sortOrder: reward.sortOrder ?? index,
      label: reward.label ?? null,
      minCartSubtotalCents: reward.minCartSubtotalCents ?? null,
    });
  }
}

/** The capacity block behind a failed activation: the same limit copy, numbers and workarounds the admin modal shows. */
async function describeCapacity(db: Db, shopId: string, failure: { code: string; offerIds: string[]; numbers: Record<string, number>; message: string; splitRefusal?: string }): Promise<CapacityBlock> {
  const block: CapacityBlock = { code: failure.code as CapacityBlock["code"], offerIds: failure.offerIds, numbers: failure.numbers, message: failure.message };
  try {
    const data = await buildCapacityModalData(db, { shopId, code: failure.code, offerIds: failure.offerIds, numbers: failure.numbers, ...(failure.splitRefusal ? { splitRefusal: failure.splitRefusal } : {}) });
    if (!data) return block;
    const copy = describeCapacityModal(data);
    block.limit = copy.limit;
    block.fix = copy.fix;
    if (data.incidentId) {
      block.incidentId = data.incidentId;
      const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.id, data.incidentId)).limit(1);
      if (incident) {
        const proposals = await proposeForIncident(db, incident);
        block.workarounds = proposals.proposals.map((p) => ({ kind: p.kind, title: p.title, summary: p.summary, customerChange: p.customerChange, semanticChange: p.semanticChange }));
      }
    }
  } catch {
    // The limit itself is already in the block; the extra copy is advisory.
  }
  return block;
}

/** After a failed publish: a shop limit (with its details), an offer that cannot be published, or a Shopify-side failure. */
async function classifyPublishFailure(db: Db, shopId: string, offerId: string): Promise<Pick<OfferGraphFailure, "code" | "capacity">> {
  const publishable = await validateOffersPublishable(db, shopId, [offerId]);
  if (!publishable.ok) return { code: "validation" };
  const capacity = await preflightCapacity(db, shopId, [offerId]);
  if (!capacity.ok) return { code: "validation", capacity: await describeCapacity(db, shopId, capacity) };
  return { code: "publish_failed" };
}

async function statusOf(db: Db, shopId: string, offerId: string): Promise<OfferStatus | undefined> {
  const [row] = await db.select({ status: offers.status }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  return row?.status as OfferStatus | undefined;
}

/** Offer + conditions + rewards + combination policy + hooks, one transaction like the wizards. */
async function insertGraph(tx: Tx, deps: AuthoringDeps, input: CreateOfferGraphInput, status: OfferStatus, name: string, opts: WriteServiceOptions): Promise<string> {
  const { offer } = input;
  const [row] = await tx
    .insert(offers)
    .values({
      shopId: deps.shopId,
      type: offer.type,
      status,
      internalName: name,
      publicTitle: offer.publicTitle,
      cartLabels: offer.cartLabels,
      description: offer.description ?? undefined,
      priority: offer.priority ?? 100,
      ...(offer.tierMode ? { tierMode: offer.tierMode } : {}),
      startsAt: offer.startsAt ?? new Date(),
      endsAt: offer.endsAt,
      timezone: deps.timezone,
      requiresCode: offer.requiresCode === true,
      createdBy: opts.performedBy,
      updatedBy: opts.performedBy,
    })
    .returning({ id: offers.id });
  if (!row) throw new Error("Failed to create offer");
  await insertConditions(tx, deps.shopId, row.id, input.conditions);
  await insertRewards(tx, deps.shopId, row.id, input.rewards);
  const policy = { ...WIZARD_POLICY_DEFAULTS, ...Object.fromEntries(Object.entries(input.policy).filter(([, value]) => value !== undefined)) };
  await tx.insert(offerCombinationPolicies).values({ shopId: deps.shopId, offerId: row.id, ...policy });
  for (const hook of input.afterInsert ?? []) await hook(tx, row.id);
  return row.id;
}

/** Runs the create in a transaction, retrying once with a suffixed name when the unique name is taken. */
async function inTxWithNameRetry<T>(run: (name: string) => Promise<T>, name: string): Promise<{ value: T; name: string }> {
  try {
    return { value: await run(name), name };
  } catch (error) {
    if (error instanceof OfferGraphRejection || error instanceof DryRunRollback || !isUniqueViolation(error)) throw error;
    const retried = withUniqueOfferSuffix(name);
    return { value: await run(retried), name: retried };
  }
}

export async function createOfferGraph(deps: AuthoringDeps, input: CreateOfferGraphInput, opts: WriteServiceOptions): Promise<OfferGraphResult> {
  const invalid = validateRows(input.conditions, input.rewards);
  if (invalid) return invalid;
  if (input.rewards.length === 0) return fail("validation", "An offer needs at least one reward.", { path: "rewards" });
  const status = statusFor(input.status, input.offer.startsAt);
  const { db } = deps;

  if (opts.dryRun) {
    try {
      await inTxWithNameRetry(
        (name) =>
          db.transaction(async (tx) => {
            const offerId = await insertGraph(tx, deps, input, status, name, opts);
            const base = { ok: true as const, dryRun: true, offerId: null, status, updatedAt: null, internalName: name };
            if (status === "draft") throw new DryRunRollback(base);
            const check = await validateActivationWithPreflight(tx as unknown as Db, deps.shopId, [offerId]);
            if (check.validation.ok) throw new DryRunRollback(base);
            const capacity = check.validation.capacity
              ? await describeCapacity(tx as unknown as Db, deps.shopId, { ...check.validation.capacity, message: check.validation.error ?? "Shopify limit reached." })
              : undefined;
            throw new DryRunRollback(fail("validation", check.validation.error ?? "The offer could not be published.", capacity ? { capacity } : {}));
          }),
        input.offer.internalName,
      );
    } catch (error) {
      if (error instanceof DryRunRollback) return error.outcome;
      if (error instanceof OfferGraphRejection) return fail("validation", error.message);
      throw error;
    }
    return fail("state", "Dry run did not complete.");
  }

  let created: { value: string; name: string };
  try {
    created = await inTxWithNameRetry((name) => db.transaction((tx) => insertGraph(tx, deps, input, status, name, opts)), input.offer.internalName);
  } catch (error) {
    if (error instanceof OfferGraphRejection) return fail("validation", error.message);
    throw error;
  }
  const offerId = created.value;
  await insertAuditLog(db, {
    shopId: deps.shopId,
    entityType: "offer",
    entityId: offerId,
    action: "create_offer",
    after: { status, type: input.offer.type, internalName: created.name, conditions: input.conditions.length, rewards: input.rewards.length, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });

  const publishError = await finalizeCreatedOffer(db, deps.shopId, deps.shopDomain, offerId, status, opts.publish);
  if (publishError) {
    const after = (await statusOf(db, deps.shopId, offerId)) ?? "draft";
    return fail("publish_failed", publishError, { offerId, status: after, ...(await classifyPublishFailure(db, deps.shopId, offerId)) });
  }
  return { ok: true, dryRun: false, offerId, status: (await statusOf(db, deps.shopId, offerId)) ?? status, updatedAt: await updatedAtOf(db, deps.shopId, offerId), internalName: created.name };
}

async function updatedAtOf(db: Db, shopId: string, offerId: string): Promise<Date | null> {
  const [row] = await db.select({ updatedAt: offers.updatedAt }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  return row?.updatedAt ?? null;
}

export async function updateOfferGraph(deps: AuthoringDeps, offerId: string, patch: UpdateOfferGraphPatch, opts: WriteServiceOptions): Promise<OfferGraphResult> {
  const { db } = deps;
  const invalid = validateRows(patch.conditions ?? [], patch.rewards ?? []);
  if (invalid) return invalid;
  if (patch.rewards && patch.rewards.length === 0) return fail("validation", "An offer needs at least one reward.", { path: "rewards" });
  const key = and(eq(offers.shopId, deps.shopId), eq(offers.id, offerId));

  const [current] = await db.select().from(offers).where(key).limit(1);
  if (!current) return fail("not_found", "Offer not found in that shop.");
  const statusBefore = current.status as OfferStatus;
  if (statusBefore === "archived") return fail("state", "Archived offers cannot be edited; duplicate it or restore it first.");
  const staleMessage = "The offer changed since it was read; read it again.";
  const isStale = (updatedAt: Date) => opts.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt.getTime() !== updatedAt.getTime();
  if (isStale(current.updatedAt)) return fail("state", staleMessage, { reason: "stale" });

  const fields = patch.offer ?? {};
  const startsAt = fields.startsAt === undefined ? current.startsAt : fields.startsAt;
  const endsAt = fields.endsAt === undefined ? current.endsAt : fields.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) return fail("validation", "End date must be after start date.", { path: "endsAt" });
  if (endsAt && !startsAt) return fail("validation", "Set a start date before setting an end date.", { path: "endsAt" });
  const scheduleChanged = fields.startsAt !== undefined || fields.endsAt !== undefined;
  const statusAfter = scheduleChanged ? statusForScheduleSave(statusBefore, startsAt, endsAt) : statusBefore;

  const setValues = {
    ...(fields.internalName !== undefined ? { internalName: fields.internalName } : {}),
    ...(fields.publicTitle !== undefined ? { publicTitle: fields.publicTitle } : {}),
    ...(fields.cartLabels !== undefined ? { cartLabels: fields.cartLabels } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
    ...(fields.tierMode !== undefined ? { tierMode: fields.tierMode } : {}),
    ...(scheduleChanged ? { startsAt, endsAt, status: statusAfter } : {}),
    updatedBy: opts.performedBy,
  };

  const apply = async (tx: Tx): Promise<Date> => {
    const [locked] = await tx.select({ updatedAt: offers.updatedAt }).from(offers).where(key).for("update").limit(1);
    if (!locked || isStale(locked.updatedAt)) throw Object.assign(new Error(staleMessage), { stale: true });
    const updatedAt = new Date();
    await tx.update(offers).set({ ...setValues, updatedAt }).where(key);
    if (patch.conditions) {
      await tx.delete(offerConditions).where(and(eq(offerConditions.shopId, deps.shopId), eq(offerConditions.offerId, offerId)));
      await insertConditions(tx, deps.shopId, offerId, patch.conditions);
    }
    if (patch.rewards) {
      await tx.delete(offerRewards).where(and(eq(offerRewards.shopId, deps.shopId), eq(offerRewards.offerId, offerId)));
      await insertRewards(tx, deps.shopId, offerId, patch.rewards);
    }
    return updatedAt;
  };

  if (opts.dryRun) {
    // A dry run applies the patch inside a transaction it rolls back, so the activation checks see the patched offer.
    try {
      await db.transaction(async (tx) => {
        await apply(tx);
        const live = statusAfter === "active";
        if (live) {
          const check = await validateActivationWithPreflight(tx as unknown as Db, deps.shopId, [offerId]);
          if (!check.validation.ok) {
            const capacity = check.validation.capacity
              ? await describeCapacity(tx as unknown as Db, deps.shopId, { ...check.validation.capacity, message: check.validation.error ?? "Shopify limit reached." })
              : undefined;
            throw new DryRunRollback(fail("validation", check.validation.error ?? "The offer could not be published.", { offerId, ...(capacity ? { capacity } : {}) }));
          }
        }
        throw new DryRunRollback({ ok: true, dryRun: true, offerId, status: statusAfter, statusBefore, updatedAt: current.updatedAt });
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.outcome;
      if ((error as { stale?: boolean }).stale) return fail("state", staleMessage, { reason: "stale" });
      if (isUniqueViolation(error)) return fail("validation", "Another offer in this shop already has that internal name.", { path: "internalName" });
      throw error;
    }
    return fail("state", "Dry run did not complete.");
  }

  let updatedAt: Date;
  try {
    updatedAt = await db.transaction(apply);
  } catch (error) {
    if ((error as { stale?: boolean }).stale) return fail("state", staleMessage, { reason: "stale" });
    if (isUniqueViolation(error)) return fail("validation", "Another offer in this shop already has that internal name.", { path: "internalName" });
    throw error;
  }
  await insertAuditLog(db, {
    shopId: deps.shopId,
    entityType: "offer",
    entityId: offerId,
    action: "update_offer",
    before: { status: statusBefore, internalName: current.internalName },
    after: {
      status: statusAfter,
      fields: Object.keys(fields),
      ...(patch.conditions ? { conditionsReplaced: patch.conditions.length } : {}),
      ...(patch.rewards ? { rewardsReplaced: patch.rewards.length } : {}),
      ...opts.auditExtra,
    },
    performedBy: opts.performedBy,
  });

  // Switching an offer on needs the same gate as every activation path; the edit is saved either way (as in the admin).
  const publishError = await republishIfActive(db, deps.shopId, deps.shopDomain, offerId, statusBefore === "active" || statusAfter === "active", opts.publish);
  if (publishError) {
    const after = (await statusOf(db, deps.shopId, offerId)) ?? statusAfter;
    return fail("publish_failed", publishError, { offerId, status: after, ...(await classifyPublishFailure(db, deps.shopId, offerId)) });
  }
  return { ok: true, dryRun: false, offerId, status: (await statusOf(db, deps.shopId, offerId)) ?? statusAfter, statusBefore, updatedAt };
}

/** The offer's stored rows, ordered, for a result that echoes what was saved. */
export async function loadOfferGraph(db: Db, shopId: string, offerId: string) {
  const [offer] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  if (!offer) return null;
  const [conditions, rewards] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))).orderBy(asc(offerConditions.sortOrder)),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))).orderBy(asc(offerRewards.sortOrder)),
  ]);
  return { offer, conditions, rewards };
}
