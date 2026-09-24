/**
 * Resumable product catalog sync. Each step imports one bounded Shopify page
 * and persists its cursor before another worker can continue.
 */

import { getDb, productCache, variantCache, catalogSyncJobs, shops } from "@promo/db";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import { decryptToken } from "../token-crypto.server.js";

const PRODUCTS_PER_PAGE = 10;
const DB_VARIANT_BATCH_SIZE = 500;
const JOB_LEASE_MS = 5 * 60_000;
const MAX_JOB_ATTEMPTS = 5;

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

type ShopifyProductSummary = Omit<ShopifyProduct, "collections" | "variants">;
interface ProductVariantsPage {
  product: { variants: { pageInfo: PageInfo; nodes: ShopifyVariant[] } } | null;
}
interface ProductCollectionsPage {
  product: { collections: { pageInfo: PageInfo; nodes: Array<{ id: string }> } } | null;
}

export const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle vendor productType tags status
        featuredMedia { ... on MediaImage { image { url } } }
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `
  query GetProductVariants($productId: ID!, $after: String) {
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
  query GetProductCollections($productId: ID!, $after: String) {
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
    products: { pageInfo: PageInfo; nodes: ShopifyProductSummary[] };
  }>({
    shopDomain,
    accessToken,
    query: PRODUCTS_QUERY,
    variables: { first: PRODUCTS_PER_PAGE, after: cursor },
  });
  return {
    pageInfo: data.products.pageInfo,
    nodes: data.products.nodes.map((product) => ({
      ...product,
      collections: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    })),
  };
}

async function hydrateProductRelations(
  shopDomain: string,
  accessToken: string,
  product: ShopifyProduct,
): Promise<ShopifyProduct> {
  const variants: ShopifyVariant[] = [];
  let variantCursor: string | null = null;
  let hasMoreVariants = true;
  while (hasMoreVariants) {
    const data: ProductVariantsPage = await shopifyGraphQL<ProductVariantsPage>({
      shopDomain,
      accessToken,
      query: PRODUCT_VARIANTS_QUERY,
      variables: { productId: product.id, after: variantCursor },
    });
    if (!data.product) throw new Error(`Product ${product.id} disappeared during variant sync`);
    variants.push(...data.product.variants.nodes);
    hasMoreVariants = data.product.variants.pageInfo.hasNextPage;
    variantCursor = hasMoreVariants ? data.product.variants.pageInfo.endCursor : null;
    if (hasMoreVariants && !variantCursor) {
      throw new Error(`Variant pagination omitted endCursor for ${product.id}`);
    }
  }

  const collections: Array<{ id: string }> = [];
  let collectionCursor: string | null = null;
  let hasMoreCollections = true;
  while (hasMoreCollections) {
    const data: ProductCollectionsPage = await shopifyGraphQL<ProductCollectionsPage>({
      shopDomain,
      accessToken,
      query: PRODUCT_COLLECTIONS_QUERY,
      variables: { productId: product.id, after: collectionCursor },
    });
    if (!data.product) throw new Error(`Product ${product.id} disappeared during collection sync`);
    collections.push(...data.product.collections.nodes);
    hasMoreCollections = data.product.collections.pageInfo.hasNextPage;
    collectionCursor = hasMoreCollections ? data.product.collections.pageInfo.endCursor : null;
    if (hasMoreCollections && !collectionCursor) {
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

export type ProductSyncStatus = "queued" | "running" | "completed" | "failed";

export async function getProductSyncJob(shopId: string) {
  const db = getDb();
  const [job] = await db.select().from(catalogSyncJobs).where(eq(catalogSyncJobs.shopId, shopId)).limit(1);
  return job ?? null;
}

/** Enqueue a fresh import unless this shop already has resumable work. */
export async function queueProductSync(shopId: string) {
  const db = getDb();
  const now = new Date();
  const [inserted] = await db
    .insert(catalogSyncJobs)
    .values({ shopId, syncStartedAt: now })
    .onConflictDoNothing({ target: catalogSyncJobs.shopId })
    .returning();
  if (inserted) return inserted;

  const [restarted] = await db
    .update(catalogSyncJobs)
    .set({
      status: "queued",
      cursor: null,
      syncedProducts: 0,
      attemptCount: 0,
      syncStartedAt: now,
      leaseUntil: null,
      lastError: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(catalogSyncJobs.shopId, shopId),
      inArray(catalogSyncJobs.status, ["completed", "failed"]),
    ))
    .returning();
  return restarted ?? await getProductSyncJob(shopId);
}

function availableJobCondition(now: Date) {
  return or(
    eq(catalogSyncJobs.status, "queued"),
    and(
      eq(catalogSyncJobs.status, "running"),
      or(isNull(catalogSyncJobs.leaseUntil), lte(catalogSyncJobs.leaseUntil, now)),
    ),
  );
}

/** Claims and imports one page. Leases make concurrent cron/UI invocations safe. */
export async function processProductSyncStep(shopId?: string) {
  const db = getDb();
  const now = new Date();
  const availability = availableJobCondition(now);
  const [candidate] = await db
    .select({ id: catalogSyncJobs.id })
    .from(catalogSyncJobs)
    .where(shopId ? and(eq(catalogSyncJobs.shopId, shopId), availability) : availability)
    .orderBy(asc(catalogSyncJobs.updatedAt))
    .limit(1);
  if (!candidate) return null;

  const [job] = await db
    .update(catalogSyncJobs)
    .set({ status: "running", leaseUntil: new Date(now.getTime() + JOB_LEASE_MS), updatedAt: now })
    .where(and(eq(catalogSyncJobs.id, candidate.id), availableJobCondition(now)))
    .returning();
  if (!job) return null;

  try {
    const [shop] = await db
      .select({
        domain: shops.myshopifyDomain,
        token: shops.accessTokenEncrypted,
        currencyCode: shops.currencyCode,
      })
      .from(shops)
      .where(and(eq(shops.id, job.shopId), eq(shops.isActive, true)))
      .limit(1);
    if (!shop) throw new Error("Active shop not found for catalog sync job");
    const accessToken = await decryptToken(shop.token);
    const page = await fetchPage(shop.domain, accessToken, job.cursor);
    const hydratedProducts: ShopifyProduct[] = [];
    for (let offset = 0; offset < page.nodes.length; offset += 5) {
      hydratedProducts.push(...await Promise.all(
        page.nodes
          .slice(offset, offset + 5)
          .map((product) => hydrateProductRelations(shop.domain, accessToken, product)),
      ));
    }
    await upsertProductPage(job.shopId, hydratedProducts, shop.currencyCode ?? "USD");
    const syncedProducts = job.syncedProducts + hydratedProducts.length;

    if (page.pageInfo.hasNextPage) {
      if (!page.pageInfo.endCursor) throw new Error("Product pagination omitted endCursor");
      const [queued] = await db.update(catalogSyncJobs).set({
        status: "queued",
        cursor: page.pageInfo.endCursor,
        syncedProducts,
        attemptCount: 0,
        leaseUntil: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(catalogSyncJobs.id, job.id)).returning();
      return queued ?? null;
    }

    // Cleanup only after every page completed. A partial or interrupted import
    // therefore never archives valid cache rows.
    await db
      .update(productCache)
      .set({ status: "ARCHIVED", syncedAt: new Date() })
      .where(and(eq(productCache.shopId, job.shopId), lt(productCache.syncedAt, job.syncStartedAt)));
    await db
      .delete(variantCache)
      .where(and(eq(variantCache.shopId, job.shopId), lt(variantCache.syncedAt, job.syncStartedAt)));

    const completedAt = new Date();
    const [completed] = await db.update(catalogSyncJobs).set({
      status: "completed",
      cursor: null,
      syncedProducts,
      attemptCount: 0,
      leaseUntil: null,
      lastError: null,
      completedAt,
      updatedAt: completedAt,
    }).where(eq(catalogSyncJobs.id, job.id)).returning();
    console.info(`[product-sync] ${shop.domain}: completed ${syncedProducts} products`);
    return completed ?? null;
  } catch (error) {
    const attemptCount = job.attemptCount + 1;
    const failed = attemptCount >= MAX_JOB_ATTEMPTS;
    const message = error instanceof Error ? error.message : "Unknown catalog sync error";
    await db.update(catalogSyncJobs).set({
      status: failed ? "failed" : "queued",
      attemptCount,
      leaseUntil: null,
      lastError: message.slice(0, 2_000),
      updatedAt: new Date(),
    }).where(eq(catalogSyncJobs.id, job.id));
    throw error;
  }
}

export async function drainProductSyncQueue(options: {
  shopId?: string;
  maxSteps?: number;
  maxRuntimeMs?: number;
} = {}) {
  const maxSteps = options.maxSteps ?? 3;
  const deadline = Date.now() + (options.maxRuntimeMs ?? 25_000);
  let steps = 0;
  let lastJob = null as Awaited<ReturnType<typeof processProductSyncStep>>;
  while (steps < maxSteps && Date.now() < deadline) {
    lastJob = await processProductSyncStep(options.shopId);
    if (!lastJob) break;
    steps += 1;
    if (lastJob.status === "completed" || lastJob.status === "failed") break;
  }
  return { steps, job: lastJob };
}
