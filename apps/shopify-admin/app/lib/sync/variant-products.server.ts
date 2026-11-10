import { variantCache, type Db } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { CompiledOffer } from "./compile-config.js";
import type { SplitOptions } from "./offer-split.js";
import { SLOT_LIMITS, unitBytes } from "./shard-planner.js";

// An offer is a split candidate only when it is a good part of a slot; the planner decides exactly.
const CANDIDATE_BYTES = SLOT_LIMITS.slotBytes / 2;
const CHUNK = 1000;

/**
 * Variant to product lookup for the offers that may need splitting, read from the catalog cache. It is used only to keep a
 * product's variants in one part (per-product caps); a variant missing from the cache makes the split refuse, never guess.
 */
export async function loadSplitOptions(db: Db, shopId: string, offers: readonly CompiledOffer[]): Promise<SplitOptions> {
  const variantIds = [
    ...new Set(
      offers
        .filter((offer) => unitBytes(offer) > CANDIDATE_BYTES)
        .flatMap((offer) => [
          ...offer.productRewards.flatMap((reward) => reward.targetVariantIds),
          ...offer.giftRewards.flatMap((reward) => reward.targetVariantIds),
          ...offer.anyRequiredVariantIds,
        ]),
    ),
  ];
  const owners = new Map<string, string>();
  for (let start = 0; start < variantIds.length; start += CHUNK) {
    const rows = await db
      .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, variantIds.slice(start, start + CHUNK))));
    for (const row of rows) owners.set(row.variantGid, row.productGid);
  }
  return { productOfVariant: (variantId) => owners.get(variantId) };
}
