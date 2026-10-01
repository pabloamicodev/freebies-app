import { and, eq, inArray, sql } from "drizzle-orm";
import { productCache, type Db } from "@promo/db";
import type { NormalizedCart } from "@promo/shared-types";

export type VolumeDiscountTier = { qty: number; percent: number };

/** Same validity filter as the legacy and discount Functions' readVolumeDiscountTiers. */
export function parseVolumeDiscountTiers(raw: unknown): VolumeDiscountTier[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is VolumeDiscountTier =>
        !!t && Number.isInteger(t.qty) && t.qty > 0 && typeof t.percent === "number" && Number.isFinite(t.percent) && t.percent >= 0,
    )
    .map((t) => ({ qty: t.qty, percent: t.percent }))
    .slice(0, 50);
}

/**
 * Overwrites every line's volumeDiscountTiers with the catalog's product metafield
 * (custom.volume_discount_tiers, synced into product_cache.raw). Client-supplied
 * values are always discarded; with `lookup` false they are just stripped.
 */
export async function withVolumeDiscountTiers(
  db: Db,
  shopId: string,
  cart: NormalizedCart,
  lookup: boolean,
): Promise<NormalizedCart> {
  const productIds = lookup ? [...new Set(cart.lines.map((line) => line.productId))] : [];
  const rows = productIds.length
    ? await db
        .select({
          productGid: productCache.productGid,
          tiers: sql<string | null>`${productCache.raw}->'volumeDiscountTiers'->>'value'`,
        })
        .from(productCache)
        .where(and(eq(productCache.shopId, shopId), inArray(productCache.productGid, productIds)))
    : [];
  const byProduct = new Map(rows.map((row) => [row.productGid, parseVolumeDiscountTiers(row.tiers)]));
  return {
    ...cart,
    lines: cart.lines.map(({ volumeDiscountTiers: _client, ...line }) => {
      const tiers = byProduct.get(line.productId);
      return tiers?.length ? { ...line, volumeDiscountTiers: tiers } : line;
    }),
  };
}
