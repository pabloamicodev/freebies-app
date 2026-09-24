import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops, productCache, variantCache } from "@promo/db";
import { and, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const SHOPIFY_VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > 100) {
      return apiError(request, { status: 400, code: "QUERY_TOO_LONG", message: "Search query is too long." });
    }
    const idsParam = url.searchParams.get("ids");
    const ids = idsParam ? [...new Set(idsParam.split(",").filter(Boolean))] : null;
    if (ids && (ids.length > 200 || ids.some((id) => !SHOPIFY_PRODUCT_GID.test(id) && !SHOPIFY_VARIANT_GID.test(id)))) {
      return apiError(request, { status: 400, code: "INVALID_PRODUCT_IDS", message: "Product identifiers are invalid." });
    }
    if (ids && ids.some((id) => SHOPIFY_PRODUCT_GID.test(id)) && ids.some((id) => SHOPIFY_VARIANT_GID.test(id))) {
      return apiError(request, {
        status: 400,
        code: "MIXED_PRODUCT_ID_TYPES",
        message: "Product and variant identifiers cannot be mixed.",
      });
    }
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Math.max(1, Math.min(Number.isNaN(limitRaw) ? 20 : limitRaw, 200));
    const includeVariants = url.searchParams.get("variants") === "true";

    const db = getDb();
    const shopRows = await db
      .select({ id: shops.id })
      .from(shops)
      .where(eq(shops.myshopifyDomain, session.shop))
      .limit(1);

    const shopId = shopRows[0]?.id;
    if (!shopId) {
      return apiError(request, {
        status: 404,
        code: "SHOP_NOT_FOUND",
        message: "Shop not found. Reinstall the app and retry.",
      });
    }

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

    if (!includeVariants) {
      return apiJson(request, { products, cache }, { status: 200 });
    }

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

    return apiJson(request, { products: enriched, cache }, { status: 200 });
  } catch (err) {
    return handleApiError(request, err, "api.products.search");
  }
};
