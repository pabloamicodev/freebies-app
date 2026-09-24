/**
 * Inline product catalog sync — runs inside the Vercel serverless function.
 */

import { getDb, productCache, variantCache } from "@promo/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { shopifyGraphQL } from "../shopify-fetch.server.js";

const PRODUCTS_PER_PAGE = 50;
const DB_VARIANT_BATCH_SIZE = 500;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

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
  featuredMedia: { image?: { url: string } | null } | null;
  collections: { nodes: Array<{ id: string }>; pageInfo: PageInfo };
  variants: { nodes: ShopifyVariant[]; pageInfo: PageInfo };
}

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle vendor productType tags status
        featuredMedia { ... on MediaImage { image { url } } }
        collections(first: 100) { nodes { id } pageInfo { hasNextPage endCursor } }
        variants(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id sku title price compareAtPrice
            inventoryQuantity inventoryPolicy availableForSale
          }
        }
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `
  query GetProductVariants($productId: ID!, $after: String!) {
    product(id: $productId) {
      variants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku title price compareAtPrice
          inventoryQuantity inventoryPolicy availableForSale
        }
      }
    }
  }
`;

export const PRODUCT_COLLECTIONS_QUERY = `
  query GetProductCollections($productId: ID!, $after: String!) {
    product(id: $productId) {
      collections(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

async function fetchPage(shopDomain: string, accessToken: string, cursor: string | null) {
  const data = await shopifyGraphQL<{
    products: { pageInfo: PageInfo; nodes: ShopifyProduct[] };
  }>({
    shopDomain,
    accessToken,
    query: PRODUCTS_QUERY,
    variables: { first: PRODUCTS_PER_PAGE, after: cursor },
  });
  return data.products;
}

async function hydrateProductRelations(
  shopDomain: string,
  accessToken: string,
  product: ShopifyProduct,
): Promise<ShopifyProduct> {
  const variants = [...product.variants.nodes];
  let variantCursor = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  while (variantCursor) {
    const data = await shopifyGraphQL<{
      product: { variants: { pageInfo: PageInfo; nodes: ShopifyVariant[] } } | null;
    }>({
      shopDomain,
      accessToken,
      query: PRODUCT_VARIANTS_QUERY,
      variables: { productId: product.id, after: variantCursor },
    });
    if (!data.product) throw new Error(`Product ${product.id} disappeared during variant sync`);
    variants.push(...data.product.variants.nodes);
    variantCursor = data.product.variants.pageInfo.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
    if (data.product.variants.pageInfo.hasNextPage && !variantCursor) {
      throw new Error(`Variant pagination omitted endCursor for ${product.id}`);
    }
  }

  const collections = [...product.collections.nodes];
  let collectionCursor = product.collections.pageInfo.hasNextPage ? product.collections.pageInfo.endCursor : null;
  while (collectionCursor) {
    const data = await shopifyGraphQL<{
      product: { collections: { pageInfo: PageInfo; nodes: Array<{ id: string }> } } | null;
    }>({
      shopDomain,
      accessToken,
      query: PRODUCT_COLLECTIONS_QUERY,
      variables: { productId: product.id, after: collectionCursor },
    });
    if (!data.product) throw new Error(`Product ${product.id} disappeared during collection sync`);
    collections.push(...data.product.collections.nodes);
    collectionCursor = data.product.collections.pageInfo.hasNextPage
      ? data.product.collections.pageInfo.endCursor
      : null;
    if (data.product.collections.pageInfo.hasNextPage && !collectionCursor) {
      throw new Error(`Collection pagination omitted endCursor for ${product.id}`);
    }
  }

  return {
    ...product,
    variants: { nodes: variants, pageInfo: { hasNextPage: false, endCursor: null } },
    collections: { nodes: collections, pageInfo: { hasNextPage: false, endCursor: null } },
  };
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
      imageUrl: product.featuredMedia?.image?.url ?? null,
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

  for (let offset = 0; offset < variants.length; offset += DB_VARIANT_BATCH_SIZE) {
    await db
      .insert(variantCache)
      .values(variants.slice(offset, offset + DB_VARIANT_BATCH_SIZE))
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
    const hydratedProducts: ShopifyProduct[] = [];
    for (let offset = 0; offset < page.nodes.length; offset += 5) {
      hydratedProducts.push(...await Promise.all(
        page.nodes
          .slice(offset, offset + 5)
          .map((product) => hydrateProductRelations(shopDomain, accessToken, product)),
      ));
    }
    await upsertProductPage(shopId, hydratedProducts, currencyCode);
    synced += hydratedProducts.length;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor) throw new Error("Product pagination omitted endCursor");
  }

  // Mark products that weren't touched in this sync as ARCHIVED (deleted from Shopify)
  await db
    .update(productCache)
    .set({ status: "ARCHIVED", syncedAt: new Date() })
    .where(and(eq(productCache.shopId, shopId), lt(productCache.syncedAt, syncStart)));

  // Variants removed from an otherwise active product don't receive a delete
  // webhook. A full sync is authoritative, so purge every untouched variant.
  await db
    .delete(variantCache)
    .where(and(eq(variantCache.shopId, shopId), lt(variantCache.syncedAt, syncStart)));

  console.info(`[product-sync] ${shopDomain}: synced ${synced} products (started ${syncStart.toISOString()})`);
  return { synced };
}
