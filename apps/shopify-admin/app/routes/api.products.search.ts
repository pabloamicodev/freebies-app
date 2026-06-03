/**
 * Product search endpoint — used by offer builder to select gift products,
 * required products, excluded products, and bundle components.
 *
 * GET /api/products/search?q=keyword&limit=20&shop=domain
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { productCache, variantCache } from "@promo/db";
import { eq, and, like, or, sql } from "drizzle-orm";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 50);
  const includeVariants = url.searchParams.get("variants") === "true";

  const db = getDb();
  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);

  const shopId = shopRows[0]?.id;
  if (!shopId) {
    return Response.json({ products: [] }, { status: 200 });
  }

  // Search in cached products (fast, no API call)
  const searchPattern = `%${q}%`;
  const products = await db
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
      and(
        eq(productCache.shopId, shopId),
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
    return Response.json({ products }, { status: 200 });
  }

  // Enrich with variants for offer configuration
  const productGids = products.map((p) => p.id);
  const variants = productGids.length > 0
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
            sql`${variantCache.productGid} = ANY(${productGids})`,
          ),
        )
        .orderBy(variantCache.productGid, variantCache.title)
    : [];

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

  return Response.json({ products: enriched }, { status: 200 });
};
