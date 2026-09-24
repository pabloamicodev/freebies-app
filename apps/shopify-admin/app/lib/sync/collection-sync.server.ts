import { getDb, productCache, type Db } from "@promo/db";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { shopifyGraphQL } from "../shopify-fetch.server.js";

const COLLECTION_PRODUCTS_QUERY = `
  query GetCollectionProducts($collectionId: ID!, $after: String) {
    collection(id: $collectionId) {
      products(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

interface CollectionProductsData {
  collection: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string }>;
    };
  } | null;
}

export async function syncCollectionFromWebhook(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  collectionGid: string,
): Promise<void> {
  const db = getDb();
  let cursor: string | null = null;
  const collectionProductGids = new Set<string>();

  do {
    const data: CollectionProductsData = await shopifyGraphQL<CollectionProductsData>({
      shopDomain,
      accessToken,
      query: COLLECTION_PRODUCTS_QUERY,
      variables: { collectionId: collectionGid, after: cursor },
    });

    const collection: CollectionProductsData["collection"] = data.collection;
    if (!collection) break;

    const productGids = collection.products.nodes.map((p) => p.id);
    productGids.forEach((id) => collectionProductGids.add(id));
    if (productGids.length > 0) {
      await db
        .update(productCache)
        .set({
          collections: sql`array_append(${productCache.collections}, ${collectionGid}::text)`,
          syncedAt: new Date(),
        })
        .where(
          and(
            eq(productCache.shopId, shopId),
            inArray(productCache.productGid, productGids),
            sql`NOT (${collectionGid}::text = ANY(${productCache.collections}))`,
          ),
        );
    }

    cursor = collection.products.pageInfo.hasNextPage ? collection.products.pageInfo.endCursor : null;
    if (collection.products.pageInfo.hasNextPage && !cursor) {
      throw new Error(`Collection pagination omitted endCursor for ${collectionGid}`);
    }
  } while (cursor);

  const removalFilter = collectionProductGids.size > 0
    ? and(
        eq(productCache.shopId, shopId),
        notInArray(productCache.productGid, [...collectionProductGids]),
        sql`${collectionGid}::text = ANY(${productCache.collections})`,
      )
    : and(
        eq(productCache.shopId, shopId),
        sql`${collectionGid}::text = ANY(${productCache.collections})`,
      );

  await db
    .update(productCache)
    .set({
      collections: sql`array_remove(${productCache.collections}, ${collectionGid}::text)`,
      syncedAt: new Date(),
    })
    .where(removalFilter);
}

export async function removeCollectionFromCache(
  shopId: string,
  collectionGid: string,
  db: Db = getDb(),
): Promise<void> {
  await db
    .update(productCache)
    .set({
      collections: sql`array_remove(${productCache.collections}, ${collectionGid}::text)`,
      syncedAt: new Date(),
    })
    .where(
      and(
        eq(productCache.shopId, shopId),
        sql`${collectionGid}::text = ANY(${productCache.collections})`,
      ),
    );
}
