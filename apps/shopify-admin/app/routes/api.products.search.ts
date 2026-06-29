import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, productCache, variantCache } from "@promo/db";
import { and, desc, eq, inArray, like, ne, or } from "drizzle-orm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const idsParam = url.searchParams.get("ids");
    const ids = idsParam ? idsParam.split(",").filter(Boolean) : null;
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Math.min(Number.isNaN(limitRaw) ? 20 : limitRaw, 200);
    const includeVariants = url.searchParams.get("variants") === "true";

    const db = getDb();
    const shopRows = await db
      .select({ id: shops.id })
      .from(shops)
      .where(eq(shops.myshopifyDomain, session.shop))
      .limit(1);

    const shopId = shopRows[0]?.id;
    if (!shopId) {
      return Response.json({ products: [] }, { status: 200 });
    }

    const lastSynced = await db
      .select({ syncedAt: productCache.syncedAt })
      .from(productCache)
      .where(eq(productCache.shopId, shopId))
      .orderBy(desc(productCache.syncedAt))
      .limit(1);
    const cache = { lastSyncedAt: lastSynced[0]?.syncedAt?.toISOString() ?? null };

    // When ids are variant GIDs, look up via variantCache first to get product GIDs
    const areVariantIds = ids && ids.length > 0 && ids[0].includes("/ProductVariant/");

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
                        like(productCache.title, searchPattern),
                        like(productCache.handle, searchPattern),
                        like(productCache.vendor, searchPattern),
                      )
                    : undefined,
                ),
          )
          .orderBy(productCache.title)
          .limit(limit);

    if (!includeVariants) {
      return Response.json({ products, cache }, { status: 200 });
    }

    const productGids = products.map((p) => p.id);
    const allVariants = productGids.length > 0
      ? await db
          .select({
            productGid: variantCache.productGid,
            id: variantCache.variantGid,
            sku: variantCache.sku,
            title: variantCache.title,
            price: variantCache.price,
            availableForSale: variantCache.availableForSale,
            inventoryQuantity: variantCache.inventoryQuantity,
            inventoryPolicy: variantCache.inventoryPolicy,
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

    return Response.json({ products: enriched, cache }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api.products.search]", message);
    return Response.json({ error: message }, { status: 500 });
  }
};
