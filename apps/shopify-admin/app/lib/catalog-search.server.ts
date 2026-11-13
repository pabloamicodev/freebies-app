import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { productCache, variantCache, type Db } from "@promo/db";

/** Product search the admin pickers use (api.products.search): title/handle/vendor ILIKE, or product / variant GIDs. */
export async function searchProductCache(
  db: Db,
  shopId: string,
  params: { q: string; ids: string[] | null; limit: number; includeVariants: boolean },
) {
  const { q, ids, limit, includeVariants } = params;
  const lastSynced = await db
    .select({ syncedAt: productCache.syncedAt })
    .from(productCache)
    .where(eq(productCache.shopId, shopId))
    .orderBy(desc(productCache.syncedAt))
    .limit(1);
  const cache = { lastSyncedAt: lastSynced[0]?.syncedAt?.toISOString() ?? null };

  // When ids are variant GIDs, look up via variantCache first to get product GIDs
  const areVariantIds = ids && ids.length > 0 && (ids[0]?.includes("/ProductVariant/") ?? false);

  let resolvedProductGidsFromVariants: string[] = [];
  let selectedVariantGids: Set<string> | null = null;
  if (areVariantIds && ids) {
    const variantRows = await db
      .select({ productGid: variantCache.productGid, variantGid: variantCache.variantGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, ids)));
    resolvedProductGidsFromVariants = [...new Set(variantRows.map((v) => v.productGid))];
    selectedVariantGids = new Set(variantRows.map((v) => v.variantGid));
  }

  const searchPattern = `%${q}%`;
  const productIds = areVariantIds ? resolvedProductGidsFromVariants : (ids ?? null);
  const products = productIds !== null && productIds.length === 0
    ? []
    : await db
        .select({
          id: productCache.productGid,
          legacyId: productCache.legacyProductId,
          title: productCache.title,
          handle: productCache.handle,
          vendor: productCache.vendor,
          productType: productCache.productType,
          imageUrl: productCache.imageUrl,
          status: productCache.status,
          tags: productCache.tags,
        })
        .from(productCache)
        .where(
          productIds
            ? and(eq(productCache.shopId, shopId), inArray(productCache.productGid, productIds))
            : and(
                eq(productCache.shopId, shopId),
                ne(productCache.status, "ARCHIVED"),
                q
                  ? or(
                      ilike(productCache.title, searchPattern),
                      ilike(productCache.handle, searchPattern),
                      ilike(productCache.vendor, searchPattern),
                    )
                  : undefined,
              ),
        )
        .orderBy(productCache.title)
        .limit(limit);

  if (!includeVariants) return { products, cache };

  const productGids = products.map((p) => p.id);
  const allVariants = productGids.length > 0
    ? await db
        .select({
          productGid: variantCache.productGid,
          id: variantCache.variantGid,
          legacyId: variantCache.legacyVariantId,
          sku: variantCache.sku,
          title: variantCache.title,
          price: variantCache.price,
          availableForSale: variantCache.availableForSale,
          inventoryQuantity: variantCache.inventoryQuantity,
          inventoryPolicy: variantCache.inventoryPolicy,
          requiresSellingPlan: variantCache.requiresSellingPlan,
        })
        .from(variantCache)
        .where(
          and(
            eq(variantCache.shopId, shopId),
            inArray(variantCache.productGid, productGids),
          ),
        )
        .orderBy(variantCache.productGid, variantCache.title)
    : [];

  // When filtering by variant GIDs, only return the selected variants
  const variants = selectedVariantGids
    ? allVariants.filter((v) => selectedVariantGids!.has(v.id))
    : allVariants;

  const variantsByProduct = variants.reduce<Record<string, typeof variants>>(
    (acc, v) => {
      (acc[v.productGid] ??= []).push(v);
      return acc;
    },
    {},
  );

  const enriched = products.map((p) => ({
    ...p,
    variants: variantsByProduct[p.id] ?? [],
  }));

  return { products: enriched, cache };
}

export type CatalogKind = "product" | "variant" | "collection" | "any";

export type CatalogSearchParams = {
  query?: string;
  ids?: string[];
  kind: CatalogKind;
  includeVariants: boolean;
  offset: number;
  limit: number;
};

export type CatalogVariant = {
  gid: string;
  numericId: number | null;
  title: string;
  sku: string | null;
  price: string;
  currency: string;
  available: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
};

export type CatalogProduct = {
  gid: string;
  numericId: number | null;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  price: { min: string; max: string; currency: string } | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  variantCount: number;
  variants?: CatalogVariant[];
};

export type CatalogCollection = { gid: string; numericId: number | null; handle: null; title: null; productCount: number };

export type CatalogSearchResult = {
  products: CatalogProduct[];
  collections: CatalogCollection[];
  hasMore: boolean;
  cache: { lastSyncedAt: string | null; products: number };
};

const GID = /^gid:\/\/shopify\/(Product|ProductVariant|Collection)\/(\d+)$/;

export type ParsedIds = {
  productGids: string[];
  variantGids: string[];
  collectionGids: string[];
  numeric: number[];
  invalid: string[];
};

/** Numeric ids can be a product, a variant or a collection id: they match every cache. */
export function parseCatalogIds(ids: string[]): ParsedIds {
  const out: ParsedIds = { productGids: [], variantGids: [], collectionGids: [], numeric: [], invalid: [] };
  for (const raw of ids) {
    const id = raw.trim();
    const gid = GID.exec(id);
    if (gid) {
      (gid[1] === "Product" ? out.productGids : gid[1] === "ProductVariant" ? out.variantGids : out.collectionGids).push(id);
    } else if (/^\d{1,18}$/.test(id)) out.numeric.push(Number(id));
    else out.invalid.push(raw);
  }
  return out;
}

const likeEscaped = (q: string) => `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
const num = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));

function money(price: string): string {
  return price.replace(/(\.\d\d)0+$/, "$1");
}

/** Cache-only catalog lookup (product_cache, variant_cache, collection membership): zero Admin API cost. */
export async function searchCatalog(
  db: Db,
  shop: { id: string; currencyCode: string },
  params: CatalogSearchParams,
): Promise<CatalogSearchResult> {
  const parsed = parseCatalogIds(params.ids ?? []);
  const query = params.query?.trim() ?? "";
  const hasIds = (params.ids?.length ?? 0) > 0;
  const wantProducts = params.kind !== "collection";
  const wantCollections = params.kind === "collection" || params.kind === "any";

  const [syncRow] = await db
    .select({ last: sql<Date | string | null>`max(${productCache.syncedAt})`, n: sql<number>`count(*)::int` })
    .from(productCache)
    .where(eq(productCache.shopId, shop.id));
  const cache = { lastSyncedAt: syncRow?.last ? new Date(syncRow.last).toISOString() : null, products: Number(syncRow?.n ?? 0) };

  let products: CatalogProduct[] = [];
  let hasMore = false;
  if (wantProducts && !(hasIds && parsed.productGids.length + parsed.variantGids.length + parsed.numeric.length === 0 && !query)) {
    const variantWhere: SQL[] = [];
    if (parsed.variantGids.length) variantWhere.push(inArray(variantCache.variantGid, parsed.variantGids));
    if (parsed.numeric.length) variantWhere.push(inArray(variantCache.legacyVariantId, parsed.numeric));
    if (query) variantWhere.push(ilike(variantCache.sku, likeEscaped(query)));
    const matchedVariants = variantWhere.length
      ? await db
          .select({ productGid: variantCache.productGid, variantGid: variantCache.variantGid })
          .from(variantCache)
          .where(and(eq(variantCache.shopId, shop.id), or(...variantWhere)))
      : [];
    const variantProducts = [...new Set(matchedVariants.map((v) => v.productGid))];

    const productWhere: SQL[] = [];
    if (parsed.productGids.length) productWhere.push(inArray(productCache.productGid, parsed.productGids));
    if (parsed.numeric.length) productWhere.push(inArray(productCache.legacyProductId, parsed.numeric));
    if (variantProducts.length) productWhere.push(inArray(productCache.productGid, variantProducts));
    if (query) {
      const pattern = likeEscaped(query);
      productWhere.push(ilike(productCache.title, pattern), ilike(productCache.handle, pattern), ilike(productCache.vendor, pattern));
    }
    const narrowed = hasIds || query !== "";
    if (!narrowed || productWhere.length > 0) {
      const rows = await db
        .select()
        .from(productCache)
        .where(and(eq(productCache.shopId, shop.id), narrowed ? or(...productWhere) : undefined))
        .orderBy(productCache.title, productCache.productGid)
        .offset(params.offset)
        .limit(params.limit + 1);
      hasMore = rows.length > params.limit;
      const page = rows.slice(0, params.limit);
      const gids = page.map((p) => p.productGid);
      const variantRows = gids.length
        ? await db
            .select()
            .from(variantCache)
            .where(and(eq(variantCache.shopId, shop.id), inArray(variantCache.productGid, gids)))
            .orderBy(variantCache.productGid, variantCache.title, variantCache.variantGid)
        : [];
      const byProduct = new Map<string, typeof variantRows>();
      for (const v of variantRows) byProduct.set(v.productGid, [...(byProduct.get(v.productGid) ?? []), v]);

      products = page.map((p) => {
        const vs = byProduct.get(p.productGid) ?? [];
        const prices = vs.map((v) => Number(v.price));
        const lo = vs.find((v) => Number(v.price) === Math.min(...prices));
        const hi = vs.find((v) => Number(v.price) === Math.max(...prices));
        const stock = vs.map((v) => v.inventoryQuantity).filter((q): q is number => q !== null);
        return {
          gid: p.productGid,
          numericId: num(p.legacyProductId),
          handle: p.handle,
          title: p.title,
          vendor: p.vendor,
          productType: p.productType,
          status: p.status,
          price: vs.length ? { min: money(lo!.price), max: money(hi!.price), currency: lo!.currencyCode || shop.currencyCode } : null,
          availableForSale: vs.some((v) => v.availableForSale),
          inventoryQuantity: stock.length ? stock.reduce((a, b) => a + b, 0) : null,
          variantCount: vs.length,
          ...(params.includeVariants
            ? {
                variants: vs.map((v) => ({
                  gid: v.variantGid,
                  numericId: num(v.legacyVariantId),
                  title: v.title,
                  sku: v.sku,
                  price: money(v.price),
                  currency: v.currencyCode || shop.currencyCode,
                  available: v.availableForSale,
                  inventoryQuantity: v.inventoryQuantity,
                  inventoryPolicy: v.inventoryPolicy,
                })),
              }
            : {}),
        };
      });
    }
  }

  let collections: CatalogCollection[] = [];
  if (wantCollections) {
    const rows = await db.execute(
      sql`select c as gid, count(*)::int as n from ${productCache}, unnest(${productCache.collections}) as c where ${productCache.shopId} = ${shop.id} group by c order by c`,
    );
    const all = ((rows as unknown as { rows?: { gid: string; n: number }[] }).rows ?? (rows as unknown as { gid: string; n: number }[]))
      .map((r) => ({ gid: r.gid, productCount: Number(r.n) }));
    const wantedGids = new Set([...parsed.collectionGids, ...parsed.numeric.map((n) => `gid://shopify/Collection/${n}`)]);
    // The cache only stores which collections a product belongs to; titles and handles are not cached, so a
    // text query cannot match a collection.
    const picked = hasIds ? all.filter((c) => wantedGids.has(c.gid)) : query ? [] : all;
    collections = picked.slice(params.offset, params.offset + params.limit).map((c) => ({
      gid: c.gid,
      numericId: num(GID.exec(c.gid)?.[2] ?? null),
      handle: null,
      title: null,
      productCount: c.productCount,
    }));
    if (params.kind === "collection") hasMore = picked.length > params.offset + params.limit;
  }

  return { products, collections, hasMore, cache };
}
