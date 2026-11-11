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
  allVariantsOf: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): TargetSelection {
  const variants = picked.filter((gid) => !PRODUCT_GID.test(gid));
  const pickedSet = new Set(variants);
  // Fail closed: a product counts as whole only when every one of its variants is picked (a blocked variant stays out).
  const whole = new Set(
    wholeProducts.filter((gid) => {
      if (!PRODUCT_GID.test(gid)) return false;
      const all = allVariantsOf.get(gid);
      return all !== undefined && all.size > 0 && [...all].every((v) => pickedSet.has(v));
    }),
  );
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
  const allVariants = new Map<string, Set<string>>();
  const claimedProducts = [...new Set(owners.values())].filter((gid) => wholeProducts.includes(gid));
  for (let start = 0; start < claimedProducts.length; start += 500) {
    const rows = await db
      .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.productGid, claimedProducts.slice(start, start + 500))));
    for (const row of rows) {
      const set = allVariants.get(row.productGid) ?? new Set<string>();
      set.add(row.variantGid);
      allVariants.set(row.productGid, set);
    }
  }
  return selectionFromPick(picked, wholeProducts, owners, allVariants);
}
