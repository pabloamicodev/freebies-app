import { getDb, productCache } from "@promo/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { SHOPIFY_API_VERSION } from "@promo/shared-types";

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

export async function syncCollectionFromWebhook(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  collectionGid: string,
): Promise<void> {
  const db = getDb();
  let cursor: string | null = null;

  do {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({
          query: COLLECTION_PRODUCTS_QUERY,
          variables: { collectionId: collectionGid, after: cursor },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    const data = (await res.json()) as {
      data?: {
        collection: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ id: string }>;
          };
        } | null;
      };
      errors?: unknown[];
    };

    if (data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);
    const collection = data.data?.collection ?? null;
    if (!collection) break;

    const productGids = collection.products.nodes.map((p) => p.id);
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
  } while (cursor);
}
