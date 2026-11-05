import { discountShards, type Db } from "@promo/db";
import { and, eq, gt } from "drizzle-orm";
import {
  automaticDiscountCountUnknownMessage,
  automaticDiscountLimitMessage,
  offerTooLargeMessage,
  sharedConfigTooLargeMessage,
  slot0GroupTooLargeMessage,
} from "../capacity-copy.js";
import { baseOfferId } from "./plan-units.js";
import type { PlanBlocked, PlanBlockCode } from "./shard-planner.js";

export interface ShardPlanBlockedContext {
  storeActive?: number | null;
  /** Flag off: a too-big single slot reads as the shared config being full, as the preflight reports it. */
  shardsEnabled?: boolean;
  /** Offer id to display name, so messages quote names and not ids. */
  names?: ReadonlyMap<string, string>;
}

/** The planner refused the plan: nothing was written and the live Shopify state is untouched. */
export class ShardPlanBlockedError extends Error {
  readonly capacity: { code: PlanBlockCode; offerIds: string[]; numbers: Record<string, number> };

  constructor(
    readonly blocked: PlanBlocked,
    context: ShardPlanBlockedContext = {},
  ) {
    const offerIds = [...new Set(blocked.unitKeys.map(baseOfferId))];
    const names = offerIds.map((id) => context.names?.get(id) ?? id);
    const { code, numbers } = shardPlanBlockedCapacity(blocked, context);
    super(shardPlanBlockedMessage(code, numbers, blocked, names, context.storeActive ?? null));
    this.name = "ShardPlanBlockedError";
    this.capacity = { code, offerIds, numbers };
  }
}

function shardPlanBlockedCapacity(blocked: PlanBlocked, context: ShardPlanBlockedContext) {
  if (context.shardsEnabled === false && blocked.reason === "bytes" && (blocked.code === "OFFER_TOO_LARGE" || blocked.code === "GROUP_TOO_LARGE")) {
    return { code: "SLOT_FULL" as PlanBlockCode, numbers: { ...blocked.numbers, neededBytes: blocked.numbers["bytes"] ?? 0 } };
  }
  if (blocked.code === "AUTOMATIC_DISCOUNT_LIMIT") {
    return { code: blocked.code, numbers: { ...blocked.numbers, needed: Math.max(1, (blocked.numbers["needed"] ?? 0) - (blocked.numbers["allowed"] ?? 0)) } };
  }
  return { code: blocked.code, numbers: blocked.numbers };
}

function shardPlanBlockedMessage(
  code: PlanBlockCode,
  numbers: Record<string, number>,
  blocked: PlanBlocked,
  names: string[],
  storeActive: number | null,
): string {
  switch (code) {
    case "SLOT_FULL":
      return sharedConfigTooLargeMessage(numbers["neededBytes"] ?? numbers["bytes"] ?? 0, names);
    case "AUTOMATIC_DISCOUNT_LIMIT":
      return storeActive === null ? automaticDiscountCountUnknownMessage() : automaticDiscountLimitMessage(storeActive, numbers["needed"] ?? 1);
    case "SLOT0_GROUP_TOO_LARGE":
      return slot0GroupTooLargeMessage(numbers["groupUnits"] ?? names.length, names);
    default:
      return offerTooLargeMessage(names, blocked.reason ?? "bytes", numbers, code === "GROUP_TOO_LARGE");
  }
}

export interface PersistedShards {
  previous: Map<string, number>;
  bytesBySlot: Map<number, number>;
}

/** Last persisted slot of each unit and byte size of each slot; the one reader the preflight and the publisher share. */
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

export async function readPreviousAssignment(db: Db, shopId: string): Promise<Map<string, number>> {
  return (await readShardState(db, shopId)).previous;
}

/** Shard nodes (slots >= 1) recorded for the shop. */
export async function countShardNodes(db: Db, shopId: string): Promise<number> {
  const rows = await db
    .select({ slot: discountShards.slot })
    .from(discountShards)
    .where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart"), gt(discountShards.slot, 0)));
  return rows.length;
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
