import { and, eq } from "drizzle-orm";
import { offerCombinationPolicies, offerRewards, offers, type Db } from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import { MAX_LIMIT, isOrderLevelOnly } from "./limit-help.js";
import { isLimitsEnforced } from "./limits-enforced.server.js";
import { limitedTitleError } from "./offer-usage.server.js";
import { republishIfActive } from "./offer-publish-flow.server.js";
import type { AuthoringDeps, StoredCombinationPolicy, WriteServiceOptions } from "./offer-authoring/types.js";

/**
 * Combination policy + usage limits of one offer. The admin combination route, the `set_combination`
 * toggle on the offer page and the MCP tool all call this, so they validate, write, audit and republish
 * the same way. Fields left undefined keep their stored value (a new policy row takes the column defaults).
 */

export const LIMIT_ERROR = `Limits must be whole numbers between 1 and ${MAX_LIMIT}, or blank for unlimited.`;

export type CombinationPolicyValues = {
  combinesWithOrderDiscounts: boolean;
  combinesWithProductDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  combinesWithOtherAppOffers: boolean;
  stopLowerPriority: boolean;
  canStackWithGiftOffers: boolean;
  giftValueCountsForOtherOffers: boolean;
  maxApplicationsPerCart: number | null;
  maxApplicationsPerCustomer: number | null;
  requireIdentifiedCustomer: boolean;
};

/** Column defaults of offer_combination_policies, used for the preview of an offer that has no row yet. */
export const DEFAULT_COMBINATION_POLICY: CombinationPolicyValues = {
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
};

const POLICY_KEYS = Object.keys(DEFAULT_COMBINATION_POLICY) as (keyof CombinationPolicyValues)[];

export type SetCombinationSuccess = {
  ok: true;
  dryRun: boolean;
  offerId: string;
  offerName: string;
  offerStatus: string;
  before: CombinationPolicyValues | null;
  after: CombinationPolicyValues;
  changed: boolean;
  /** Advisory only (never blocks): the per-customer limit needs a unique customer-facing title and limits are not enforced yet. */
  warning: string | null;
  /** The per-cart limit was dropped because the offer's rewards are order/shipping level (applied once per order). */
  perCartIgnored: boolean;
};

export type SetCombinationFailure =
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "validation"; error: string }
  | { ok: false; code: "stale"; error: string }
  /** The policy IS saved; republishing failed (the offer may have been paused). `error` is the admin banner text. */
  | { ok: false; code: "publish_failed"; error: string };

export type SetCombinationResult = SetCombinationSuccess | SetCombinationFailure;

const validLimit = (v: number | null | undefined) => v === undefined || v === null || (Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT);

function pick(row: Record<string, unknown>): CombinationPolicyValues {
  const out: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) out[key] = row[key] ?? DEFAULT_COMBINATION_POLICY[key];
  return out as CombinationPolicyValues;
}

export async function setCombinationPolicy(
  deps: Pick<AuthoringDeps, "db" | "shopId" | "shopDomain">,
  offerId: string,
  input: StoredCombinationPolicy,
  opts: WriteServiceOptions,
): Promise<SetCombinationResult> {
  const { db, shopId, shopDomain } = deps;
  const [offer] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  if (!offer) return { ok: false, code: "not_found", error: "Offer not found." };
  if (opts.expectedUpdatedAt && offer.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
    return { ok: false, code: "stale", error: "The offer changed since you read it; read it again and retry." };
  }

  const rewardRows = await db.select({ rewardType: offerRewards.rewardType }).from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
  // The per-cart field does not exist for order/shipping-only offers (applied once per order): ignore anything sent for it.
  const orderLevel = isOrderLevelOnly(rewardRows.map((r) => r.rewardType));
  const perCartIgnored = orderLevel && input.maxApplicationsPerCart != null;
  const perCart = orderLevel ? (input.maxApplicationsPerCart === undefined ? undefined : null) : input.maxApplicationsPerCart;
  if (!validLimit(perCart) || !validLimit(input.maxApplicationsPerCustomer)) return { ok: false, code: "validation", error: LIMIT_ERROR };

  // The unique-title rule only matters once limits are enforced for the shop; until then it is a warning.
  let warning: string | null = null;
  if (typeof input.maxApplicationsPerCustomer === "number") {
    const titleError = await limitedTitleError(db, shopId, offerId);
    if (titleError) {
      if (await isLimitsEnforced(db, shopId)) return { ok: false, code: "validation", error: titleError };
      warning = titleError;
    }
  }

  const changes: Partial<CombinationPolicyValues> = {};
  for (const key of POLICY_KEYS) {
    const value = key === "maxApplicationsPerCart" ? perCart : input[key];
    if (value !== undefined) (changes as Record<string, unknown>)[key] = value;
  }

  const [existing] = await db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1);
  const before = existing ? pick(existing) : null;
  const after = { ...(before ?? DEFAULT_COMBINATION_POLICY), ...changes };
  const changed = !before || POLICY_KEYS.some((key) => before[key] !== after[key]);
  const base = { offerId, offerName: offer.internalName, offerStatus: offer.status, before, after, changed, warning, perCartIgnored };
  if (opts.dryRun) return { ok: true, dryRun: true, ...base };

  await db
    .insert(offerCombinationPolicies)
    .values({ shopId, offerId, ...changes })
    .onConflictDoUpdate({ target: [offerCombinationPolicies.offerId], set: { ...changes, updatedAt: new Date() } });
  await insertAuditLog(db, {
    shopId,
    entityType: "offer",
    entityId: offerId,
    action: "set_combination",
    before,
    after: { ...after, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });

  const publishError = await republishIfActive(db as Db, shopId, shopDomain, offerId, offer.status === "active", opts.publish);
  if (publishError) return { ok: false, code: "publish_failed", error: publishError };
  return { ok: true, dryRun: false, ...base };
}
