import { variantCache, type Db } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

export interface TargetSelection {
  productIds: string[];
  variantIds: string[];
  /** Set only when nothing but whole products was picked, so the compiler may ship product ids alone. */
  selectionLevel?: "product";
}

/**
 * A variant picker expands a product the merchant ticked into all its variants. The picker also reports which products
 * were ticked as a whole; those go back to product ids, and only the variants picked on their own stay variants. A claimed
 * product with no picked variant is ignored. New saves only: stored rows are never rewritten.
 */
export function selectionFromPick(
  picked: readonly string[],
  wholeProducts: readonly string[],
  ownerOf: ReadonlyMap<string, string>,
): TargetSelection {
  const whole = new Set(wholeProducts.filter((gid) => PRODUCT_GID.test(gid)));
  const variants = picked.filter((gid) => !PRODUCT_GID.test(gid));
  const claimed = new Set(variants.map((gid) => ownerOf.get(gid)).filter((owner): owner is string => owner !== undefined && whole.has(owner)));
  const pickedProducts = picked.filter((gid) => PRODUCT_GID.test(gid));
  const productIds = [...new Set([...pickedProducts, ...claimed])];
  const variantIds = variants.filter((gid) => !claimed.has(ownerOf.get(gid) ?? ""));
  return { productIds, variantIds, ...(productIds.length > 0 && variantIds.length === 0 ? { selectionLevel: "product" as const } : {}) };
}

export async function resolveSelection(db: Db, shopId: string, picked: readonly string[], wholeProducts: readonly string[]): Promise<TargetSelection> {
  const variants = picked.filter((gid) => VARIANT_GID.test(gid));
  const owners = new Map<string, string>();
  if (wholeProducts.length > 0 && variants.length > 0) {
    for (let start = 0; start < variants.length; start += 1000) {
      const rows = await db
        .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
        .from(variantCache)
        .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, variants.slice(start, start + 1000))));
      for (const row of rows) owners.set(row.variantGid, row.productGid);
    }
  }
  return selectionFromPick(picked, wholeProducts, owners);
}
