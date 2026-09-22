/**
 * Inline product catalog sync — runs inside the Vercel serverless function.
 */

import { getDb, productCache, variantCache } from "@promo/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { SHOPIFY_API_VERSION } from "../shopify-api-version.js";

const PRODUCTS_PER_PAGE = 250;

interface ShopifyVariant {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number;
  inventoryPolicy: string;
  availableForSale: boolean;
}

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  featuredImage: { url: string } | null;
  collections: { nodes: Array<{ id: string }> };
  variants: { nodes: ShopifyVariant[] };
}

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle vendor productType tags status
        featuredImage { url }
        collections(first: 100) { nodes { id } }
        variants(first: 100) {
          nodes {
            id sku title price compareAtPrice
            inventoryQuantity inventoryPolicy availableForSale
          }
        }
      }
    }
  }
`;

async function fetchPage(shopDomain: string, accessToken: string, cursor: string | null) {
  const res = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: { first: PRODUCTS_PER_PAGE, after: cursor },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as {
    data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProduct[] } };
    errors?: unknown[];
  };
  if (json.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(json.errors[0])}`);
  return json.data!.products;
}

/** Upserts a whole page (up to 250 products + their variants) in two batch
 * statements instead of one round-trip per product/variant — at catalog
 * scale (thousands of SKUs) the original per-row loop was the sync's
 * dominant cost and its main risk of running past the serverless timeout. */
async function upsertProductPage(shopId: string, products: ShopifyProduct[], currencyCode: string) {
  if (products.length === 0) return;
  const db = getDb();
  const now = new Date();

  await db
    .insert(productCache)
    .values(products.map((product) => ({
      shopId,
      productGid: product.id,
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      status: product.status,
      imageUrl: product.featuredImage?.url ?? null,
      collections: product.collections.nodes.map((c) => c.id),
      raw: product,
      syncedAt: now,
    })))
    .onConflictDoUpdate({
      target: [productCache.shopId, productCache.productGid],
      set: {
        handle: sql`excluded.handle`,
        title: sql`excluded.title`,
        vendor: sql`excluded.vendor`,
        productType: sql`excluded.product_type`,
        tags: sql`excluded.tags`,
        status: sql`excluded.status`,
        imageUrl: sql`excluded.image_url`,
        collections: sql`excluded.collections`,
        raw: sql`excluded.raw`,
        syncedAt: sql`excluded.synced_at`,
      },
    });

  const variants = products.flatMap((product) => product.variants.nodes.map((v) => ({
    shopId,
    productGid: product.id,
    variantGid: v.id,
    sku: v.sku || null,
    title: v.title,
    price: v.price,
    compareAtPrice: v.compareAtPrice ?? null,
    currencyCode,
    inventoryQuantity: v.inventoryQuantity,
    inventoryPolicy: v.inventoryPolicy,
    availableForSale: v.availableForSale,
    raw: v,
    syncedAt: now,
  })));
  if (variants.length === 0) return;

  await db
    .insert(variantCache)
    .values(variants)
    .onConflictDoUpdate({
      target: [variantCache.shopId, variantCache.variantGid],
      set: {
        sku: sql`excluded.sku`,
        title: sql`excluded.title`,
        price: sql`excluded.price`,
        compareAtPrice: sql`excluded.compare_at_price`,
        inventoryQuantity: sql`excluded.inventory_quantity`,
        inventoryPolicy: sql`excluded.inventory_policy`,
        availableForSale: sql`excluded.available_for_sale`,
        raw: sql`excluded.raw`,
        syncedAt: sql`excluded.synced_at`,
      },
    });
}

export async function syncAllProducts(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  currencyCode: string,
): Promise<{ synced: number }> {
  const db = getDb();
  const syncStart = new Date();
  let cursor: string | null = null;
  let synced = 0;

  for (;;) {
    const page = await fetchPage(shopDomain, accessToken, cursor);
    await upsertProductPage(shopId, page.nodes, currencyCode);
    synced += page.nodes.length;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  // Mark products that weren't touched in this sync as ARCHIVED (deleted from Shopify)
  await db
    .update(productCache)
    .set({ status: "ARCHIVED", syncedAt: new Date() })
    .where(and(eq(productCache.shopId, shopId), lt(productCache.syncedAt, syncStart)));

  console.info(`[product-sync] ${shopDomain}: synced ${synced} products (started ${syncStart.toISOString()})`);
  return { synced };
}
