/**
 * Ensures the shop has an automatic app discount backed by the Promo Engine
 * Discount Function, and returns its GID. The offer-publisher writes the
 * compiled offer config metafield onto this node — the Discount Function
 * reads it from there, not from the shop.
 *
 * Idempotent: runs once per shop (afterAuth), persists the discount GID on
 * `shops.discountId`, and is a no-op on reinstall if it's already set.
 */
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const DISCOUNT_TITLE = "Promo Engine";

export interface DiscountCombinationPolicyInput {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

export async function ensureDiscountNode(
  shopId: string,
  shopDomain: string,
  accessToken: string,
): Promise<string> {
  const db = getDb();

  const [existing] = await db.select({ discountId: shops.discountId }).from(shops).where(eq(shops.id, shopId)).limit(1);
  if (existing?.discountId) return existing.discountId;

  const functionId = await findDiscountFunctionId(shopDomain, accessToken);
  if (!functionId) {
    throw new Error("Could not find the Promo Engine Discount Function. Has it been deployed with `shopify app deploy`?");
  }

  const discountId = await createOrFindAutomaticDiscount(shopDomain, accessToken, functionId);

  await db.update(shops).set({ discountId, updatedAt: new Date() }).where(eq(shops.id, shopId));

  return discountId;
}

export async function syncDiscountCombinationPolicy(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  combinesWith: DiscountCombinationPolicyInput,
): Promise<void> {
  const data = await shopifyGraphQL<{
    discountAutomaticAppUpdate: {
      automaticAppDiscount: { discountId: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: `mutation UpdatePromoEngineDiscountCombination($id: ID!, $discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    variables: {
      id: discountId,
      discount: { combinesWith },
    },
  });

  const result = data.discountAutomaticAppUpdate;
  if (result.userErrors.length > 0 || !result.automaticAppDiscount) {
    const messages = result.userErrors.map((error) => error.message).join(", ");
    throw new Error(`discountAutomaticAppUpdate failed: ${messages || "Shopify returned no updated discount"}`);
  }
}

async function findDiscountFunctionId(shopDomain: string, accessToken: string): Promise<string | null> {
  const data = await shopifyGraphQL<{
    shopifyFunctions: { nodes: Array<{ id: string; apiType: string; title: string }> };
  }>({
    shopDomain,
    accessToken,
    query: `query FindDiscountFunction {
      shopifyFunctions(first: 25) {
        nodes { id apiType title }
      }
    }`,
  });

  const match = data.shopifyFunctions.nodes.find((fn) => fn.apiType === "product_discounts" || fn.apiType === "discount");
  return match?.id ?? null;
}

/** Reuses an existing "Promo Engine" automatic discount if one is already
 * registered (e.g. a previous afterAuth run failed after creating it but
 * before we could persist the id) — avoids creating duplicates on retry. */
async function createOrFindAutomaticDiscount(shopDomain: string, accessToken: string, functionId: string): Promise<string> {
  const created = await shopifyGraphQL<{
    discountAutomaticAppCreate: {
      automaticAppDiscount: { discountId: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
    };
  }>({
    shopDomain,
    accessToken,
    query: `mutation CreatePromoEngineDiscount($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    variables: {
      discount: {
        title: DISCOUNT_TITLE,
        functionId,
        startsAt: new Date().toISOString(),
        combinesWith: {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true,
        },
      },
    },
  });

  const result = created.discountAutomaticAppCreate;
  if (result.automaticAppDiscount) return result.automaticAppDiscount.discountId;

  const alreadyExists = result.userErrors.some((e) => e.message.toLowerCase().includes("already"));
  if (!alreadyExists) {
    throw new Error(`discountAutomaticAppCreate failed: ${result.userErrors.map((e) => e.message).join(", ")}`);
  }

  const existingId = await findExistingAutomaticDiscount(shopDomain, accessToken, functionId);
  if (!existingId) {
    throw new Error(`discountAutomaticAppCreate reported a duplicate but no matching discount was found: ${result.userErrors.map((e) => e.message).join(", ")}`);
  }
  return existingId;
}

async function findExistingAutomaticDiscount(shopDomain: string, accessToken: string, functionId: string): Promise<string | null> {
  const data = await shopifyGraphQL<{
    discountNodes: { nodes: Array<{ id: string; discount: { __typename: string; appDiscountType?: { functionId: string } } }> };
  }>({
    shopDomain,
    accessToken,
    query: `query FindExistingAutomaticDiscount {
      discountNodes(first: 50) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp { appDiscountType { functionId } }
          }
        }
      }
    }`,
  });

  const match = data.discountNodes.nodes.find(
    (node) => node.discount.__typename === "DiscountAutomaticApp" && node.discount.appDiscountType?.functionId === functionId,
  );
  return match?.id ?? null;
}
