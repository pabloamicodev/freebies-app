import { Worker, type Job } from "bullmq";
import { redis, QUEUES } from "./queues.js";
import { getDb, productCache, variantCache, shops } from "@promo/db";
import { and, eq, lt } from "drizzle-orm";
import pino from "pino";
import { SHOPIFY_API_VERSION } from "@promo/shared-types";

const log = pino({ name: "product-sync-worker" });

async function decryptAccessToken(stored: string): Promise<string> {
  const sep = stored.indexOf(":");
  if (sep === -1) return stored;
  const keyHex = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!keyHex) return stored;
  try {
    const key = await crypto.subtle.importKey("raw", Buffer.from(keyHex, "hex"), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(stored.slice(0, sep), "hex") }, key, Buffer.from(stored.slice(sep + 1), "hex"));
    return new TextDecoder().decode(plaintext);
  } catch { return stored; }
}

export interface ProductSyncJobData {
  shopId: string;
  shopDomain: string;
  /** "full" = sync all products; "partial" = sync specific product by GID. */
  mode: "full" | "partial";
  productGid?: string;
}
const PRODUCTS_PER_PAGE = 250;

async function fetchProductsPage(
  shopDomain: string,
  accessToken: string,
  cursor: string | null,
): Promise<{
  products: ShopifyProduct[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const afterClause = cursor ? `, after: "${cursor}"` : "";
  const query = `
    query GetProducts($first: Int!) {
      products(first: $first${afterClause}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          legacyResourceId
          title
          handle
          vendor
          productType
          tags
          status
          featuredImage { url }
          collections(first: 100) { nodes { id } }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              sku
              title
              price
              compareAtPrice
              inventoryQuantity
              inventoryPolicy
              availableForSale
              requiresSellingPlan
            }
          }
        }
      }
    }
  `;

  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: { first: PRODUCTS_PER_PAGE } }),
    },
  );

  if (!response.ok) {
    throw new Error(`Shopify Admin API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data: { products: ShopifyProductsResponse } };
  const products = data.data.products;
  return {
    products: products.nodes,
    hasNextPage: products.pageInfo.hasNextPage,
    endCursor: products.pageInfo.endCursor,
  };
}

async function syncProduct(shopId: string, product: ShopifyProduct, currencyCode: string) {
  const db = getDb();

  await db
    .insert(productCache)
    .values({
      shopId,
      productGid: product.id,
      legacyProductId: parseInt(product.legacyResourceId, 10),
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      status: product.status,
      imageUrl: product.featuredImage?.url ?? null,
      collections: product.collections.nodes.map((c) => c.id),
      raw: product,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [productCache.shopId, productCache.productGid],
      set: {
        handle: product.handle,
        title: product.title,
        vendor: product.vendor,
        productType: product.productType,
        tags: product.tags,
        status: product.status,
        imageUrl: product.featuredImage?.url ?? null,
        collections: product.collections.nodes.map((c) => c.id),
        raw: product,
        syncedAt: new Date(),
      },
    });

  for (const variant of product.variants.nodes) {
    await db
      .insert(variantCache)
      .values({
        shopId,
        productGid: product.id,
        variantGid: variant.id,
        legacyVariantId: parseInt(variant.legacyResourceId, 10),
        sku: variant.sku || null,
        title: variant.title,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice ?? null,
        currencyCode,
        inventoryQuantity: variant.inventoryQuantity,
        inventoryPolicy: variant.inventoryPolicy,
        availableForSale: variant.availableForSale,
        requiresSellingPlan: variant.requiresSellingPlan,
        raw: variant,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [variantCache.shopId, variantCache.variantGid],
        set: {
          sku: variant.sku || null,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          inventoryQuantity: variant.inventoryQuantity,
          inventoryPolicy: variant.inventoryPolicy,
          availableForSale: variant.availableForSale,
          raw: variant,
          syncedAt: new Date(),
        },
      });
  }
}

export function startProductSyncWorker() {
  const worker = new Worker<ProductSyncJobData>(
    QUEUES.PRODUCT_SYNC,
    async (job: Job<ProductSyncJobData>) => {
      const { shopId, shopDomain, mode, productGid } = job.data;

      // Get shop currency + decrypt access token
      const db = getDb();
      const shopRows = await db
        .select({ currencyCode: shops.currencyCode, accessTokenEncrypted: shops.accessTokenEncrypted })
        .from(shops)
        .where(eq(shops.id, shopId))
        .limit(1);
      if (!shopRows[0]) throw new Error(`Shop ${shopId} not found`);
      const currencyCode = shopRows[0].currencyCode ?? "USD";
      const accessToken = await decryptAccessToken(shopRows[0].accessTokenEncrypted);

      if (mode === "partial" && productGid) {
        // Sync single product
        log.info({ shopDomain, productGid }, "Syncing single product");
        const response = await fetch(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({
              query: `query { product(id: "${productGid}") { id legacyResourceId title handle vendor productType tags status featuredImage { url } collections(first: 100) { nodes { id } } variants(first: 100) { nodes { id legacyResourceId sku title price compareAtPrice inventoryQuantity inventoryPolicy availableForSale requiresSellingPlan } } } }`,
            }),
          },
        );
        const data = (await response.json()) as { data: { product: ShopifyProduct } };
        if (data.data.product) {
          await syncProduct(shopId, data.data.product, currencyCode);
        }
        return;
      }

      // Full sync
      log.info({ shopDomain }, "Starting full product sync");
      const syncStartedAt = new Date();
      let cursor: string | null = null;
      let totalSynced = 0;
      let hasMore = true;

      while (hasMore) {
        const page = await fetchProductsPage(shopDomain, accessToken, cursor);
        for (const product of page.products) {
          await syncProduct(shopId, product, currencyCode);
          totalSynced++;
        }
        hasMore = page.hasNextPage;
        cursor = page.endCursor;
        await job.updateProgress(Math.round((totalSynced / 250) * 100));
      }

      const archivedMissing = await db
        .update(productCache)
        .set({ status: "ARCHIVED", syncedAt: new Date() })
        .where(and(eq(productCache.shopId, shopId), lt(productCache.syncedAt, syncStartedAt)))
        .returning({ id: productCache.id });

      log.info({ shopDomain, totalSynced, archivedMissing: archivedMissing.length }, "Full product sync complete");
    },
    {
      connection: redis,
      concurrency: 3,
      limiter: { max: 2, duration: 1000 },
    },
  );

  worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.id, shopDomain: job?.data.shopDomain, mode: job?.data.mode, err: err.message },
      "product-sync job failed permanently",
    );
  });

  return worker;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShopifyProductsResponse {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: ShopifyProduct[];
}

interface ShopifyProduct {
  id: string;
  legacyResourceId: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  featuredImage: { url: string } | null;
  collections: { nodes: Array<{ id: string }> };
  variants: {
    nodes: Array<{
      id: string;
      legacyResourceId: string;
      sku: string;
      title: string;
      price: string;
      compareAtPrice: string | null;
      inventoryQuantity: number;
      inventoryPolicy: string;
      availableForSale: boolean;
      requiresSellingPlan: boolean;
    }>;
  };
}
