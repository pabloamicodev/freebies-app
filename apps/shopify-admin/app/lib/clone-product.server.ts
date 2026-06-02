/**
 * Clone Product Mode — creates $0 or discounted gift products.
 *
 * When gift.logic_mode = "clone_product":
 * 1. For each gift reward, create a cloned product in Shopify:
 *    - Price = 0 (for "free") or discounted price
 *    - Tagged with: promo-engine-gift
 *    - Handle: {original-handle}-promo-gift
 *    - Hidden from search, collections, sitemaps
 * 2. Store the clone GID in gift_clone_products table.
 * 3. Sync inventory if sync_quantity_enabled.
 * 4. Block direct purchase via Validation Function.
 * 5. On offer archive: archive the clone product.
 * 6. On app uninstall: archive all clone products.
 */

const SHOPIFY_API_VERSION = "2026-04";
const CLONE_TAG = "promo-engine-gift";
const CLONE_HANDLE_SUFFIX = "-promo-gift";

export interface CreateCloneOptions {
  shopDomain: string;
  accessToken: string;
  sourceProductGid: string;
  sourceVariantGid: string;
  discountedPriceCents: number;
  offerId: string;
  rewardId: string;
}

export interface CloneResult {
  cloneProductGid: string;
  cloneVariantGid: string;
  cloneHandle: string;
}

/** Create a cloned gift product via Shopify Admin GraphQL API. */
export async function createCloneProduct(opts: CreateCloneOptions): Promise<CloneResult> {
  // 1. Fetch source product details
  const sourceQuery = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        title handle vendor productType tags
        images(first: 1) { nodes { url } }
      }
    }
  `;

  const sourceRes = await fetch(
    `https://${opts.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": opts.accessToken },
      body: JSON.stringify({ query: sourceQuery, variables: { id: opts.sourceProductGid } }),
    },
  );

  const sourceData = (await sourceRes.json()) as {
    data: {
      product: {
        title: string; handle: string; vendor: string; productType: string;
        tags: string[]; images: { nodes: Array<{ url: string }> };
      };
    };
  };

  const source = sourceData.data.product;
  const cloneHandle = `${source.handle}${CLONE_HANDLE_SUFFIX}-${opts.offerId.slice(0, 8)}`;
  const priceDollars = (opts.discountedPriceCents / 100).toFixed(2);

  // 2. Create clone product — hidden from all sales channels initially
  const createMutation = `
    mutation ProductCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product { id handle variants(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }
  `;

  const createRes = await fetch(
    `https://${opts.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": opts.accessToken },
      body: JSON.stringify({
        query: createMutation,
        variables: {
          input: {
            title: `${source.title} (Gift)`,
            handle: cloneHandle,
            vendor: source.vendor,
            productType: source.productType,
            tags: [...source.tags, CLONE_TAG],
            status: "ACTIVE",
            // SEO: noindex via metafield
            metafields: [
              { namespace: "seo", key: "hidden", type: "integer", value: "1" },
              { namespace: "promo_engine", key: "source_product_gid", type: "single_line_text_field", value: opts.sourceProductGid },
              { namespace: "promo_engine", key: "offer_id", type: "single_line_text_field", value: opts.offerId },
            ],
            variants: [{ price: priceDollars, compareAtPrice: null }],
          },
        },
      }),
    },
  );

  const createData = (await createRes.json()) as {
    data: {
      productCreate: {
        product: { id: string; handle: string; variants: { nodes: Array<{ id: string }> } };
        userErrors: Array<{ message: string }>;
      };
    };
  };

  const errors = createData.data.productCreate.userErrors;
  if (errors.length > 0) {
    throw new Error(`Clone product creation failed: ${errors.map((e) => e.message).join(", ")}`);
  }

  const clone = createData.data.productCreate.product;
  const cloneVariantGid = clone.variants.nodes[0]?.id ?? "";

  return {
    cloneProductGid: clone.id,
    cloneVariantGid,
    cloneHandle: clone.handle,
  };
}

/** Archive a clone product when the offer is archived. */
export async function archiveCloneProduct(
  shopDomain: string,
  accessToken: string,
  cloneProductGid: string,
): Promise<void> {
  const mutation = `
    mutation ProductUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `;

  await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({
      query: mutation,
      variables: { input: { id: cloneProductGid, status: "ARCHIVED" } },
    }),
  });
}
