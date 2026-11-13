import { and, eq } from "drizzle-orm";
import { offerRewards, offers } from "@promo/db";
import { validateRewardPayload } from "@promo/shared-types";
import { insertAuditLog } from "./audit-log.server.js";
import { lowerMainThresholdToLowestTier } from "./gift-tiered-offer.server.js";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";
import { republishIfActive } from "./offer-publish-flow.server.js";
import { buildRewardRecordFromInput, type RewardInput, type RewardRecordData } from "./reward-record.server.js";

/**
 * Reward editor of an offer (add, update, delete, gift tier mode). The admin rewards route and the MCP tools both
 * call it: validate -> write -> republish if the offer is live -> audit. No Request/Response.
 */

export type OfferRewardFailure = {
  ok: false;
  error: string;
  /** not_found: offer or reward missing; validation: bad input; state: stale expectedUpdatedAt; publish_failed: saved but the Shopify publish failed. */
  code: "not_found" | "validation" | "state" | "publish_failed";
};
export type OfferRewardResult<T> = { ok: true; value: T } | OfferRewardFailure;

/** A reward to write: typed editor fields (validated and normalized here) or an already stored row (only schema-validated). */
export type RewardWrite = { input: RewardInput } | { record: RewardRecordData };

export type RewardWriteValue = { rewardId: string | null; rewardType: string; discountType: string; dryRun: boolean };

const fail = (code: OfferRewardFailure["code"], error: string): OfferRewardFailure => ({ ok: false, code, error });

async function loadOffer(deps: AuthoringDeps, offerId: string) {
  const [offer] = await deps.db
    .select({ status: offers.status, updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, deps.shopId), eq(offers.id, offerId)))
    .limit(1);
  return offer;
}

function staleError(offer: { updatedAt: Date }, opts: WriteServiceOptions): OfferRewardFailure | null {
  if (opts.expectedUpdatedAt && offer.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
    return fail("state", "The offer changed since you read it; re-read it and retry.");
  }
  return null;
}

async function publishAfter(deps: AuthoringDeps, offerId: string, wasActive: boolean, opts: WriteServiceOptions): Promise<OfferRewardFailure | null> {
  const publishError = await republishIfActive(deps.db, deps.shopId, deps.shopDomain, offerId, wasActive, opts.publish);
  return publishError ? fail("publish_failed", publishError) : null;
}

async function build(
  deps: AuthoringDeps,
  reward: RewardWrite,
  existing: { rewardType: string; value: unknown } | null,
): Promise<{ data: RewardRecordData } | OfferRewardFailure> {
  if ("input" in reward) {
    const built = await buildRewardRecordFromInput(reward.input, deps.db, deps.shopId, deps.shopCurrency, existing);
    return "error" in built ? fail("validation", built.error) : { data: built.data };
  }
  const data = reward.record;
  const payload = validateRewardPayload(data.rewardType, data.discountType, data.value, data.target);
  if (!payload.success) return fail("validation", payload.error.issues[0]?.message ?? "Reward configuration is invalid.");
  return { data };
}

async function writeReward(
  deps: AuthoringDeps,
  offerId: string,
  editedId: string | null,
  reward: RewardWrite,
  opts: WriteServiceOptions,
): Promise<OfferRewardResult<RewardWriteValue>> {
  const offer = await loadOffer(deps, offerId);
  if (!offer) return fail("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;
  const { db, shopId } = deps;

  let current: { rewardType: string; value: unknown; min: number | null } | null = null;
  if (editedId !== null) {
    if (!editedId) return fail("validation", "Reward ID missing.");
    const [row] = await db
      .select({ rewardType: offerRewards.rewardType, value: offerRewards.value, min: offerRewards.minCartSubtotalCents })
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, editedId)))
      .limit(1);
    if (!row) return fail("not_found", "Reward not found in this offer.");
    current = row;
  }
  const built = await build(deps, reward, current);
  if ("error" in built) return built;
  const { rewardType, discountType, value, target, quantity, isAutoAdd, isCustomerSelectable, trackMode, label, minCartSubtotalCents } = built.data;
  if (minCartSubtotalCents) {
    const siblings = await db
      .select({ id: offerRewards.id, min: offerRewards.minCartSubtotalCents })
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.rewardType, "product_gift")));
    if (siblings.some((sibling) => sibling.id !== editedId && sibling.min === minCartSubtotalCents)) {
      return fail("validation", "Another gift in this offer already unlocks at that cart subtotal. Each tier needs its own amount.");
    }
  }
  // Gift tier: posted blank clears it, an absent field keeps it, and a reward that stops being a gift loses it.
  const tierColumn = rewardType !== "product_gift" ? { minCartSubtotalCents: null } : minCartSubtotalCents !== undefined ? { minCartSubtotalCents } : {};
  const tierChanged = minCartSubtotalCents !== undefined && (editedId === null || minCartSubtotalCents !== (current?.min ?? null));
  const summary = { rewardId: editedId, rewardType, discountType, dryRun: opts.dryRun === true };
  if (opts.dryRun) return { ok: true, value: summary };

  let rewardId = editedId;
  await db.transaction(async (tx) => {
    if (editedId === null) {
      const existing = await tx
        .select({ id: offerRewards.id })
        .from(offerRewards)
        .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
      const [inserted] = await tx
        .insert(offerRewards)
        .values({ shopId, offerId, rewardType, discountType, value, target, quantity, isAutoAdd, isCustomerSelectable, trackMode, sortOrder: existing.length, label, ...tierColumn })
        .returning({ id: offerRewards.id });
      rewardId = inserted?.id ?? null;
    } else {
      await tx
        .update(offerRewards)
        .set({ rewardType, discountType, value, target, quantity, isAutoAdd, isCustomerSelectable, trackMode, label, ...tierColumn })
        .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, editedId)));
    }
    if (tierChanged) await lowerMainThresholdToLowestTier(tx as unknown as typeof db, shopId, offerId);
  });
  const published = await publishAfter(deps, offerId, offer.status === "active", opts);
  if (published) return published;
  await insertAuditLog(db, {
    shopId,
    entityType: "offer_reward",
    entityId: offerId,
    action: editedId === null ? "add_reward" : "update_reward",
    after: { rewardType, discountType, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });
  return { ok: true, value: { ...summary, rewardId } };
}

export function addReward(deps: AuthoringDeps, offerId: string, reward: RewardWrite, opts: WriteServiceOptions) {
  return writeReward(deps, offerId, null, reward, opts);
}

export function updateReward(deps: AuthoringDeps, offerId: string, rewardId: string, reward: RewardWrite, opts: WriteServiceOptions) {
  return writeReward(deps, offerId, rewardId, reward, opts);
}

export async function deleteReward(
  deps: AuthoringDeps,
  offerId: string,
  rewardId: string,
  opts: WriteServiceOptions,
): Promise<OfferRewardResult<{ rewardId: string; remaining: number; dryRun: boolean }>> {
  if (!rewardId) return fail("validation", "Reward ID missing.");
  const offer = await loadOffer(deps, offerId);
  if (!offer) return fail("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;
  const { db, shopId } = deps;
  const rewards = await db
    .select({ id: offerRewards.id })
    .from(offerRewards)
    .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
  if (!rewards.some((reward) => reward.id === rewardId)) return fail("not_found", "Reward not found in this offer.");
  if (offer.status === "active" && rewards.length <= 1) {
    return fail("validation", "Cannot delete the last reward from an active offer. Pause it first or add another reward.");
  }
  const result = { rewardId, remaining: rewards.length - 1, dryRun: opts.dryRun === true };
  if (opts.dryRun) return { ok: true, value: result };
  await db.delete(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, rewardId)));
  const published = await publishAfter(deps, offerId, offer.status === "active", opts);
  if (published) return published;
  await insertAuditLog(db, {
    shopId,
    entityType: "offer_reward",
    entityId: rewardId,
    action: "delete_reward",
    before: { offerId },
    ...(opts.auditExtra ? { after: opts.auditExtra } : {}),
    performedBy: opts.performedBy,
  });
  return { ok: true, value: result };
}

export async function setTierMode(
  deps: AuthoringDeps,
  offerId: string,
  mode: "cumulative" | "highest",
  opts: WriteServiceOptions,
): Promise<OfferRewardResult<{ tierMode: "cumulative" | "highest"; dryRun: boolean }>> {
  const offer = await loadOffer(deps, offerId);
  if (!offer) return fail("not_found", "Offer not found.");
  const stale = staleError(offer, opts);
  if (stale) return stale;
  const result = { tierMode: mode, dryRun: opts.dryRun === true };
  if (opts.dryRun) return { ok: true, value: result };
  const { db, shopId } = deps;
  await db.update(offers).set({ tierMode: mode, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  const published = await publishAfter(deps, offerId, offer.status === "active", opts);
  if (published) return published;
  await insertAuditLog(db, {
    shopId,
    entityType: "offer",
    entityId: offerId,
    action: "set_tier_mode",
    after: { tierMode: mode, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });
  return { ok: true, value: result };
}
