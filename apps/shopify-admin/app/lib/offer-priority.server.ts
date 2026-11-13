import { and, eq } from "drizzle-orm";
import { offerCombinationPolicies, offers, type Db } from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import { detectConflicts, type OfferConflict } from "./conflict-detection.server.js";
import { republishIfActive } from "./offer-publish-flow.server.js";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";

/**
 * Priority + "stop lower-priority offers" of one offer. Shared by the admin priority route and the MCP tool.
 * Lower number = evaluated first. Conflicts are the shop-wide detector's findings that involve this offer.
 */

const PG_INT_MAX = 2_147_483_647;

export type SetPriorityInput = { priority: number; stopLowerPriority?: boolean };

export type SetPrioritySuccess = {
  ok: true;
  dryRun: boolean;
  offerId: string;
  offerName: string;
  offerStatus: string;
  before: { priority: number; stopLowerPriority: boolean };
  after: { priority: number; stopLowerPriority: boolean };
  changed: boolean;
  /** Conflicts involving this offer, read after the write (on a dry run: with the stored state, the change is not simulated). */
  conflicts: OfferConflict[];
};

export type SetPriorityFailure =
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "validation"; error: string }
  | { ok: false; code: "stale"; error: string }
  /** The change IS saved; republishing failed (the offer may have been paused). */
  | { ok: false; code: "publish_failed"; error: string };

export type SetPriorityResult = SetPrioritySuccess | SetPriorityFailure;

export async function setPriority(
  deps: Pick<AuthoringDeps, "db" | "shopId" | "shopDomain">,
  offerId: string,
  input: SetPriorityInput,
  opts: WriteServiceOptions,
): Promise<SetPriorityResult> {
  const { db, shopId, shopDomain } = deps;
  if (!Number.isInteger(input.priority) || Math.abs(input.priority) > PG_INT_MAX) {
    return { ok: false, code: "validation", error: "Invalid priority" };
  }
  const [offer] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId))).limit(1);
  if (!offer) return { ok: false, code: "not_found", error: "Offer not found." };
  if (opts.expectedUpdatedAt && offer.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
    return { ok: false, code: "stale", error: "The offer changed since you read it; read it again and retry." };
  }

  const [policy] = await db
    .select({ stopLowerPriority: offerCombinationPolicies.stopLowerPriority })
    .from(offerCombinationPolicies)
    .where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId)))
    .limit(1);
  const before = { priority: offer.priority, stopLowerPriority: policy?.stopLowerPriority ?? false };
  const after = { priority: input.priority, stopLowerPriority: input.stopLowerPriority ?? before.stopLowerPriority };
  const changed = before.priority !== after.priority || before.stopLowerPriority !== after.stopLowerPriority;
  const base = { offerId, offerName: offer.internalName, offerStatus: offer.status, before, after, changed };
  const involvingOffer = async () => (await detectConflicts(shopId, db as Db)).filter((c) => c.offerIds.includes(offerId));
  if (opts.dryRun) return { ok: true, dryRun: true, ...base, conflicts: await involvingOffer() };

  await db.update(offers).set({ priority: after.priority, updatedAt: new Date() }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  if (input.stopLowerPriority !== undefined) {
    await db
      .insert(offerCombinationPolicies)
      .values({ shopId, offerId, stopLowerPriority: after.stopLowerPriority })
      .onConflictDoUpdate({ target: [offerCombinationPolicies.offerId], set: { stopLowerPriority: after.stopLowerPriority, updatedAt: new Date() } });
  }
  await insertAuditLog(db, {
    shopId,
    entityType: "offer",
    entityId: offerId,
    action: "set_priority",
    before,
    after: { ...after, ...opts.auditExtra },
    performedBy: opts.performedBy,
  });

  const publishError = await republishIfActive(db as Db, shopId, shopDomain, offerId, offer.status === "active", opts.publish);
  if (publishError) return { ok: false, code: "publish_failed", error: publishError };
  return { ok: true, dryRun: false, ...base, conflicts: await involvingOffer() };
}
