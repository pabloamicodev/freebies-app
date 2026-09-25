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

const CART_DISCOUNT_TITLE = "Promo Engine";
const DELIVERY_DISCOUNT_TITLE = "Promo Engine Shipping";
export const CART_FUNCTION_TITLE = "Promo Engine Discount";
export const DELIVERY_FUNCTION_TITLE = "Promo Engine Delivery Discount";
export type DiscountClass = "ORDER" | "PRODUCT" | "SHIPPING";
export const CART_DISCOUNT_CLASSES = [
  "PRODUCT",
  "ORDER",
] as const satisfies readonly DiscountClass[];
export const DELIVERY_DISCOUNT_CLASSES = ["SHIPPING"] as const satisfies readonly DiscountClass[];

interface ShopifyFunctionSummary {
  id: string;
  apiType: string;
  handle: string;
  title: string;
}

export interface DiscountNodeIds {
  cartLinesDiscountId: string;
  deliveryDiscountId: string;
}

export interface DiscountCombinationPolicyInput {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

export async function ensureDiscountNodes(
  shopId: string,
  shopDomain: string,
  accessToken: string,
): Promise<DiscountNodeIds> {
  const db = getDb();

  const [existing] = await db
    .select({
      discountId: shops.discountId,
      deliveryDiscountId: shops.deliveryDiscountId,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (existing?.discountId && existing.deliveryDiscountId) {
    return {
      cartLinesDiscountId: existing.discountId,
      deliveryDiscountId: existing.deliveryDiscountId,
    };
  }

  const functions = await findDiscountFunctions(shopDomain, accessToken);
  const cartFunction = selectFunction(functions, CART_FUNCTION_TITLE);
  const deliveryFunction = selectFunction(functions, DELIVERY_FUNCTION_TITLE);
  if (!cartFunction || !deliveryFunction) {
    throw new Error(
      "Could not find both Promo Engine Discount Functions. Deploy the current Shopify app version before publishing offers.",
    );
  }

  const cartLinesDiscountId =
    existing?.discountId ??
    (await createOrFindAutomaticDiscount(
      shopDomain,
      accessToken,
      cartFunction,
      CART_DISCOUNT_TITLE,
      CART_DISCOUNT_CLASSES,
    ));
  const deliveryDiscountId =
    existing?.deliveryDiscountId ??
    (await createOrFindAutomaticDiscount(
      shopDomain,
      accessToken,
      deliveryFunction,
      DELIVERY_DISCOUNT_TITLE,
      DELIVERY_DISCOUNT_CLASSES,
    ));

  await db
    .update(shops)
    .set({
      discountId: cartLinesDiscountId,
      deliveryDiscountId,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId));

  return { cartLinesDiscountId, deliveryDiscountId };
}

export async function syncDiscountCombinationPolicy(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
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
      discount: buildAutomaticDiscountUpdateInput(combinesWith, discountClasses),
    },
  });

  const result = data.discountAutomaticAppUpdate;
  if (result.userErrors.length > 0 || !result.automaticAppDiscount) {
    const messages = result.userErrors.map((error) => error.message).join(", ");
    throw new Error(
      `discountAutomaticAppUpdate failed: ${messages || "Shopify returned no updated discount"}`,
    );
  }
}

async function findDiscountFunctions(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyFunctionSummary[]> {
  const data = await shopifyGraphQL<{
    shopifyFunctions: { nodes: ShopifyFunctionSummary[] };
  }>({
    shopDomain,
    accessToken,
    query: `query FindDiscountFunction {
      shopifyFunctions(first: 25) {
        nodes { id apiType handle title }
      }
    }`,
  });

  return data.shopifyFunctions.nodes;
}

export function selectFunctionId(
  functions: ShopifyFunctionSummary[],
  expectedTitle: string,
): string | null {
  return selectFunction(functions, expectedTitle)?.id ?? null;
}

function selectFunction(
  functions: ShopifyFunctionSummary[],
  expectedTitle: string,
): ShopifyFunctionSummary | null {
  const normalizedTitle = expectedTitle.trim().toLocaleLowerCase();
  const match = functions.find((fn) => fn.title.trim().toLocaleLowerCase() === normalizedTitle);
  return match ?? null;
}

export function buildAutomaticDiscountCreateInput(
  functionHandle: string,
  title: string,
  discountClasses: readonly DiscountClass[],
  startsAt = new Date().toISOString(),
) {
  return {
    title,
    functionHandle,
    discountClasses: [...discountClasses],
    startsAt,
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
  };
}

export function buildAutomaticDiscountUpdateInput(
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
) {
  return { combinesWith, discountClasses: [...discountClasses] };
}

/** Reuses an existing "Promo Engine" automatic discount if one is already
 * registered (e.g. a previous afterAuth run failed after creating it but
 * before we could persist the id) — avoids creating duplicates on retry. */
async function createOrFindAutomaticDiscount(
  shopDomain: string,
  accessToken: string,
  shopifyFunction: ShopifyFunctionSummary,
  title: string,
  discountClasses: readonly DiscountClass[],
): Promise<string> {
  const existingId = await findExistingAutomaticDiscount(
    shopDomain,
    accessToken,
    shopifyFunction.id,
  );
  if (existingId) return existingId;

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
      discount: buildAutomaticDiscountCreateInput(shopifyFunction.handle, title, discountClasses),
    },
  });

  const result = created.discountAutomaticAppCreate;
  if (result.automaticAppDiscount) return result.automaticAppDiscount.discountId;

  const alreadyExists = result.userErrors.some((e) => e.message.toLowerCase().includes("already"));
  if (!alreadyExists) {
    throw new Error(
      `discountAutomaticAppCreate failed: ${result.userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const recoveredId = await findExistingAutomaticDiscount(
    shopDomain,
    accessToken,
    shopifyFunction.id,
  );
  if (!recoveredId) {
    throw new Error(
      `discountAutomaticAppCreate reported a duplicate but no matching discount was found: ${result.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  return recoveredId;
}

async function findExistingAutomaticDiscount(
  shopDomain: string,
  accessToken: string,
  functionId: string,
): Promise<string | null> {
  const data = await shopifyGraphQL<{
    discountNodes: {
      nodes: Array<{
        id: string;
        discount: { __typename: string; appDiscountType?: { functionId: string } };
      }>;
    };
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
    (node) =>
      node.discount.__typename === "DiscountAutomaticApp" &&
      node.discount.appDiscountType?.functionId === functionId,
  );
  return match?.id ?? null;
}
