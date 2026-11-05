import { discountShards, type Db, type OfferCondition } from "@promo/db";
import { and, eq, gt } from "drizzle-orm";
import { AutomaticDiscountLimitError } from "../discount-node.server.js";
import { cartAttributeKeys } from "./attribute-query-variables.js";
import type { CompiledOffer } from "./compile-config.js";
import { unitBytes, type PlanBlocked, type PlanUnit } from "./shard-planner.js";

export function sharedConfigTooLargeMessage(bytes: number, limit = 9500): string {
  return `The shared automatic config would be ${bytes}B, over the ${limit}B limit. Pause or simplify other automatic offers first.`;
}

/** The planner refused the plan: nothing was written and the live Shopify state is untouched. */
export class ShardPlanBlockedError extends Error {
  constructor(
    readonly blocked: PlanBlocked,
    storeActive: number | null = null,
  ) {
    super(shardPlanBlockedMessage(blocked, storeActive));
    this.name = "ShardPlanBlockedError";
  }
}

function shardPlanBlockedMessage(blocked: PlanBlocked, storeActive: number | null): string {
  const { code, numbers } = blocked;
  if (code === "SLOT_FULL") return sharedConfigTooLargeMessage(numbers["neededBytes"] ?? 0, numbers["slotBytes"]);
  if (code === "AUTOMATIC_DISCOUNT_LIMIT") {
    const wanted = Math.max(1, (numbers["needed"] ?? 0) - (numbers["allowed"] ?? 0));
    return new AutomaticDiscountLimitError(storeActive ?? 0, wanted, "cart-shard").message;
  }
  if (code === "SLOT0_GROUP_TOO_LARGE") {
    return `Offers that apply order discounts or stop lower-priority offers must run together in one Shopify discount, and together they are ${numbers["groupBytes"]}B, over the ${numbers["slotBytes"]}B limit. Pause or simplify these offers first.`;
  }
  const limit = blocked.reason === "keys" ? "cart attribute keys" : blocked.reason === "tags" ? "customer tags" : "size";
  return `An offer is too large for one Shopify discount (limit: ${limit}). Pause or simplify these offers first.`;
}

const rewardProductIds = (offer: CompiledOffer): string[] | null => {
  const ids = new Set<string>();
  for (const reward of offer.productRewards) {
    if (reward.targetProductIds.length === 0) return null;
    reward.targetProductIds.forEach((id) => ids.add(id));
  }
  return [...ids];
};

export function buildPlanUnits(offers: readonly CompiledOffer[], conditionRows: readonly OfferCondition[]): PlanUnit[] {
  return offers.map((offer) => ({
    key: offer.id,
    bytes: unitBytes(offer),
    cartAttributeKeys: cartAttributeKeys(conditionRows.filter((row) => row.offerId === offer.id)),
    customerTags: [...new Set([...(offer.requiredCustomerTags ?? []), ...(offer.excludedCustomerTags ?? [])])],
    priority: offer.priority,
    hasOrderRewards: offer.orderRewards.length > 0,
    stopLowerPriority: offer.stopLowerPriority,
    targetProductIds: rewardProductIds(offer),
    multiLineFixed: offer.productRewards.some((reward) => reward.scopeMode === "quiz_bundle"),
  }));
}

export interface PersistedShards {
  previous: Map<string, number>;
  bytesBySlot: Map<number, number>;
}

export async function readShardState(db: Db, shopId: string): Promise<PersistedShards> {
  const rows = await db
    .select({ slot: discountShards.slot, unitKeys: discountShards.unitKeys, configBytes: discountShards.configBytes })
    .from(discountShards)
    .where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart")));
  const previous = new Map<string, number>();
  const bytesBySlot = new Map<number, number>();
  for (const row of rows) {
    for (const key of row.unitKeys) previous.set(key, row.slot);
    if (row.configBytes !== null) bytesBySlot.set(row.slot, row.configBytes);
  }
  return { previous, bytesBySlot };
}

export interface PublishedSlot {
  slot: number;
  nodeId: string;
  unitKeys: string[];
  configBytes: number;
  configHash: string;
}

/** Records what the last metafieldsSet put on each slot. Slots past the new count are emptied, not removed (their nodes are deleted separately). */
export async function saveShardState(db: Db, shopId: string, slots: readonly PublishedSlot[]): Promise<void> {
  const now = new Date();
  for (const slot of slots) {
    const values = {
      discountNodeId: slot.nodeId,
      unitKeys: slot.unitKeys,
      configBytes: slot.configBytes,
      configHash: slot.configHash,
      publishedAt: now,
      updatedAt: now,
    };
    await db
      .insert(discountShards)
      .values({ shopId, kind: "cart", slot: slot.slot, ...values })
      .onConflictDoUpdate({ target: [discountShards.shopId, discountShards.kind, discountShards.slot], set: values });
  }
  await db
    .update(discountShards)
    .set({ unitKeys: [], configBytes: null, configHash: null, updatedAt: now })
    .where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart"), gt(discountShards.slot, slots.length - 1)));
}

export async function clearShardState(db: Db, shopId: string): Promise<void> {
  await db.delete(discountShards).where(eq(discountShards.shopId, shopId));
}
