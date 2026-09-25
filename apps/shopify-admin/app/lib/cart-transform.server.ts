import { shopifyGraphQL } from "./shopify-fetch.server.js";

const CART_TRANSFORM_HANDLE = "promo-engine-cart-transform";

interface CartTransformState {
  shopifyFunctions: { nodes: Array<{ id: string; apiType: string; handle: string }> };
  cartTransforms: { nodes: Array<{ id: string; functionId: string }> };
}

interface CartTransformCreateResult {
  cartTransformCreate: {
    cartTransform: { id: string } | null;
    userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
  };
}

/**
 * Registers the bundle Cart Transform on the shop. A deployed function does
 * nothing until cartTransformCreate activates it. Idempotent.
 */
export async function ensureCartTransform(shopDomain: string, accessToken: string): Promise<string> {
  const state = await shopifyGraphQL<CartTransformState>({
    shopDomain,
    accessToken,
    query: `query CartTransformState {
      shopifyFunctions(first: 25) { nodes { id apiType handle } }
      cartTransforms(first: 10) { nodes { id functionId } }
    }`,
  });

  const fn = state.shopifyFunctions.nodes.find(
    (node) => node.handle === CART_TRANSFORM_HANDLE || node.apiType === "cart_transform",
  );
  if (!fn) throw new Error("Promo Engine Cart Transform function is not deployed. Run `shopify app deploy`.");

  const existing = state.cartTransforms.nodes.find((node) => node.functionId === fn.id);
  if (existing) return existing.id;

  const result = await shopifyGraphQL<CartTransformCreateResult>({
    shopDomain,
    accessToken,
    query: `mutation EnsureCartTransform($functionHandle: String!) {
      cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: false) {
        cartTransform { id }
        userErrors { field message code }
      }
    }`,
    variables: { functionHandle: CART_TRANSFORM_HANDLE },
  });

  const { cartTransform, userErrors } = result.cartTransformCreate;
  if (!cartTransform) {
    throw new Error(`cartTransformCreate failed: ${userErrors.map((error) => error.message).join("; ") || "unknown error"}`);
  }
  return cartTransform.id;
}
