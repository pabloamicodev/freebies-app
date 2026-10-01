/**
 * Ensures the shop has an automatic app discount backed by the Promo Engine
 * Discount Function, and returns its GID. The offer-publisher writes the
 * compiled offer config metafield onto this node — the Discount Function
 * reads it from there, not from the shop.
 *
 * Idempotent: runs once per shop (afterAuth), persists the discount GID on
 * `shops.discountId`, and is a no-op on reinstall if it's already set.
 */
import { appSettings, getDb, shops } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const CART_DISCOUNT_TITLE = "Promo Engine";
const DELIVERY_DISCOUNT_TITLE = "Promo Engine Shipping";
export const CART_FUNCTION_TITLE = "Promo Engine Discount";
export const DELIVERY_FUNCTION_TITLE = "Promo Engine Delivery Discount";
export const CODE_FUNCTION_TITLE = "Promo Engine Code Discount";
const CODE_DISCOUNT_TITLE = "Promo Engine Codes";
export const CODE_NODE_SETTING = "code_discount_node.id";
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
export type { ShopifyFunctionSummary };

export interface DiscountNodeIds {
  cartLinesDiscountId: string;
  deliveryDiscountId: string;
}

export interface DiscountCombinationPolicyInput {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

interface DiscountUserError {
  field: string[] | null;
  message: string;
  code?: string;
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

  // A stored id doesn't mean the node still exists — a reinstall can leave a
  // stale id from a discount the merchant (or a previous uninstall) removed.
  // Verify before trusting it, so a deleted node self-heals instead of every
  // publish silently writing metafields onto a discount that's gone.
  let verifiedCartId: string | null = null;
  let verifiedDeliveryId: string | null = null;
  if (existing?.discountId && existing.deliveryDiscountId) {
    const [cartExists, deliveryExists] = await Promise.all([
      discountNodeExists(shopDomain, accessToken, existing.discountId),
      discountNodeExists(shopDomain, accessToken, existing.deliveryDiscountId),
    ]);
    verifiedCartId = cartExists ? existing.discountId : null;
    verifiedDeliveryId = deliveryExists ? existing.deliveryDiscountId : null;
    if (verifiedCartId && verifiedDeliveryId) {
      return { cartLinesDiscountId: verifiedCartId, deliveryDiscountId: verifiedDeliveryId };
    }
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
    verifiedCartId ??
    (await createOrFindAutomaticDiscount(
      shopDomain,
      accessToken,
      cartFunction,
      CART_DISCOUNT_TITLE,
      CART_DISCOUNT_CLASSES,
    ));
  const deliveryDiscountId =
    verifiedDeliveryId ??
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
      userErrors: DiscountUserError[];
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
    const messages = formatDiscountUserErrors(result.userErrors);
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
  const combinesWith = normalizeDiscountCombinationPolicy(
    {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    discountClasses,
  );

  return {
    title,
    functionHandle,
    discountClasses: [...discountClasses],
    startsAt,
    combinesWith,
  };
}

export function buildAutomaticDiscountUpdateInput(
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
) {
  return {
    combinesWith: normalizeDiscountCombinationPolicy(combinesWith, discountClasses),
    discountClasses: [...discountClasses],
  };
}

function normalizeDiscountCombinationPolicy(
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
): DiscountCombinationPolicyInput {
  const isShippingOnly = discountClasses.length === 1 && discountClasses[0] === "SHIPPING";
  return isShippingOnly ? { ...combinesWith, shippingDiscounts: false } : combinesWith;
}

export function formatDiscountUserErrors(errors: DiscountUserError[]): string {
  return errors
    .map((error) => {
      const code = error.code ? `[${error.code}] ` : "";
      const field = error.field?.length ? `${error.field.join(".")}: ` : "";
      return `${code}${field}${error.message}`;
    })
    .join(", ");
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
      userErrors: DiscountUserError[];
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
      `discountAutomaticAppCreate failed: ${formatDiscountUserErrors(result.userErrors) || "Shopify returned no created discount"}`,
    );
  }

  const recoveredId = await findExistingAutomaticDiscount(
    shopDomain,
    accessToken,
    shopifyFunction.id,
  );
  if (!recoveredId) {
    throw new Error(
      `discountAutomaticAppCreate reported a duplicate but no matching discount was found: ${formatDiscountUserErrors(result.userErrors)}`,
    );
  }
  return recoveredId;
}

/** Looks up the deployed cart-lines discount Function summary (same lookup
 * `ensureDiscountNodes` does internally) — exported so callers that need a
 * dedicated code discount pointed at the SAME Function (e.g. the
 * offer-publisher, for code-gated offers) don't have to re-implement the
 * `shopifyFunctions` query + title match. */
export async function findCartDiscountFunction(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyFunctionSummary> {
  const functions = await findDiscountFunctions(shopDomain, accessToken);
  const cartFunction = selectFunction(functions, CART_FUNCTION_TITLE);
  if (!cartFunction) {
    throw new Error(
      "Could not find the Promo Engine Discount Function. Deploy the current Shopify app version before publishing offers.",
    );
  }
  return cartFunction;
}

/** The delivery-options Function, for code discounts that carry shipping rewards. */
export async function findDeliveryDiscountFunction(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyFunctionSummary> {
  const functions = await findDiscountFunctions(shopDomain, accessToken);
  const deliveryFunction = selectFunction(functions, DELIVERY_FUNCTION_TITLE);
  if (!deliveryFunction) {
    throw new Error(
      "Could not find the Promo Engine Delivery Discount Function. Deploy the current Shopify app version before publishing offers.",
    );
  }
  return deliveryFunction;
}

/** Function id behind a code discount node; null when the node no longer exists. */
export async function getCodeDiscountFunctionId(
  shopDomain: string,
  accessToken: string,
  id: string,
): Promise<string | null | undefined> {
  const data = await shopifyGraphQL<{
    codeDiscountNode: {
      id: string;
      codeDiscount: { appDiscountType?: { functionId: string } };
    } | null;
  }>({
    shopDomain,
    accessToken,
    query: `query CheckCodeDiscountNode($id: ID!) {
      codeDiscountNode(id: $id) {
        id
        codeDiscount { ... on DiscountCodeApp { appDiscountType { functionId } } }
      }
    }`,
    variables: { id },
  });
  if (!data.codeDiscountNode) return null;
  return data.codeDiscountNode.codeDiscount.appDiscountType?.functionId;
}

/** Verifies a stored discount node id still resolves to a live discount —
 * `discountNode` returns null instead of erroring for a deleted node, unlike
 * most other Shopify Admin API GID lookups. */
export async function discountNodeExists(
  shopDomain: string,
  accessToken: string,
  id: string,
): Promise<boolean> {
  const data = await shopifyGraphQL<{ discountNode: { id: string } | null }>({
    shopDomain,
    accessToken,
    query: `query CheckDiscountNode($id: ID!) {
      discountNode(id: $id) { id }
    }`,
    variables: { id },
  });
  return data.discountNode != null;
}

const DISCOUNT_NODES_PAGE_SIZE = 50;
const DISCOUNT_NODES_MAX_PAGES = 10;

interface DiscountNodesPage {
  discountNodes: {
    nodes: Array<{
      id: string;
      discount: {
        __typename: string;
        appDiscountType?: { functionId: string };
        codes?: { nodes: Array<{ code: string }> };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function fetchDiscountNodesPage(
  shopDomain: string,
  accessToken: string,
  cursor: string | null,
): Promise<DiscountNodesPage> {
  return shopifyGraphQL<DiscountNodesPage>({
    shopDomain,
    accessToken,
    query: `query FindExistingAppDiscount($first: Int!, $after: String) {
      discountNodes(first: $first, after: $after) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp { appDiscountType { functionId } }
            ... on DiscountCodeApp {
              appDiscountType { functionId }
              codes(first: 1) { nodes { code } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    variables: { first: DISCOUNT_NODES_PAGE_SIZE, after: cursor },
  });
}

async function findExistingAutomaticDiscount(
  shopDomain: string,
  accessToken: string,
  functionId: string,
): Promise<string | null> {
  // Paginate instead of trusting the first 50 — a shop with many discounts
  // (legacy or from other apps) could push the Promo Engine one past that
  // window, which meant a second afterAuth run would create a duplicate.
  let cursor: string | null = null;
  for (let page = 0; page < DISCOUNT_NODES_MAX_PAGES; page += 1) {
    const data: DiscountNodesPage = await fetchDiscountNodesPage(shopDomain, accessToken, cursor);

    const match = data.discountNodes.nodes.find(
      (node) =>
        node.discount.__typename === "DiscountAutomaticApp" &&
        node.discount.appDiscountType?.functionId === functionId,
    );
    if (match) return match.id;

    const pageInfo = data.discountNodes.pageInfo;
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return null;
}

/** Reuses an existing "DiscountCodeApp" node for this Function + code if one
 * is already registered — the code-discount analogue of
 * `findExistingAutomaticDiscount`, used to recover from a create that
 * reported "already exists" (e.g. a previous publish created the node but
 * failed before `offers.codeDiscountId` could be persisted). Codes are
 * matched case-insensitively since Shopify itself treats them that way, and
 * `code` here is already the normalized (trimmed, uppercased) value stored
 * on the offer. */
async function findExistingCodeDiscount(
  shopDomain: string,
  accessToken: string,
  functionId: string,
  code: string,
): Promise<string | null> {
  const normalizedCode = code.trim().toUpperCase();
  let cursor: string | null = null;
  for (let page = 0; page < DISCOUNT_NODES_MAX_PAGES; page += 1) {
    const data: DiscountNodesPage = await fetchDiscountNodesPage(shopDomain, accessToken, cursor);

    const match = data.discountNodes.nodes.find(
      (node) =>
        node.discount.__typename === "DiscountCodeApp" &&
        node.discount.appDiscountType?.functionId === functionId &&
        (node.discount.codes?.nodes ?? []).some(
          (c) => c.code.trim().toUpperCase() === normalizedCode,
        ),
    );
    if (match) return match.id;

    const pageInfo = data.discountNodes.pageInfo;
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return null;
}

export interface CodeDiscountNodeOptions {
  /** Node-wide cap, shared by every code on the node. */
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  /** Set to expire the node (no code on it works); null reopens it. */
  endsAt?: string | null;
}

function codeNodeOptionFields(options: CodeDiscountNodeOptions) {
  return {
    ...(options.usageLimit !== undefined ? { usageLimit: options.usageLimit } : {}),
    ...(options.appliesOncePerCustomer !== undefined
      ? { appliesOncePerCustomer: options.appliesOncePerCustomer }
      : {}),
    ...(options.endsAt !== undefined ? { endsAt: options.endsAt } : {}),
  };
}

export function buildCodeDiscountCreateInput(
  functionHandle: string,
  code: string,
  title: string,
  discountClasses: readonly DiscountClass[],
  startsAt = new Date().toISOString(),
  options: CodeDiscountNodeOptions = {},
) {
  const combinesWith = normalizeDiscountCombinationPolicy(
    {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    discountClasses,
  );

  return {
    title,
    code,
    functionHandle,
    discountClasses: [...discountClasses],
    startsAt,
    combinesWith,
    ...codeNodeOptionFields(options),
  };
}

export function buildCodeDiscountUpdateInput(
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
  options: CodeDiscountNodeOptions = {},
) {
  return {
    combinesWith: normalizeDiscountCombinationPolicy(combinesWith, discountClasses),
    discountClasses: [...discountClasses],
    ...codeNodeOptionFields(options),
  };
}

/**
 * Creates a dedicated `discountCodeAppCreate` node for a code-gated offer,
 * pointed at the same already-deployed cart-lines Function the shared
 * automatic "Promo Engine" discount uses — Shopify only invokes the
 * Function for a code discount when that exact code is present on the cart,
 * so no Function/rule-engine change is needed to support this.
 *
 * This does NOT check for a pre-existing node by itself (unlike
 * `createOrFindAutomaticDiscount`, which is a per-shop singleton lookup):
 * callers here already track the discount id on `offers.codeDiscountId` and
 * verify it with `discountNodeExists` before calling this, so the only
 * "existing" case this needs to recover is Shopify reporting a duplicate on
 * create (e.g. a previous publish created the node but crashed before the
 * id could be persisted).
 */
export async function createOrFindCodeDiscount(
  shopDomain: string,
  accessToken: string,
  shopifyFunction: ShopifyFunctionSummary,
  code: string,
  title: string,
  discountClasses: readonly DiscountClass[],
  options: CodeDiscountNodeOptions = {},
): Promise<string> {
  const created = await shopifyGraphQL<{
    discountCodeAppCreate: {
      codeAppDiscount: { discountId: string } | null;
      userErrors: DiscountUserError[];
    };
  }>({
    shopDomain,
    accessToken,
    query: `mutation CreatePromoEngineCodeDiscount($discount: DiscountCodeAppInput!) {
      discountCodeAppCreate(codeAppDiscount: $discount) {
        codeAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    variables: {
      discount: buildCodeDiscountCreateInput(
        shopifyFunction.handle,
        code,
        title,
        discountClasses,
        undefined,
        options,
      ),
    },
  });

  const result = created.discountCodeAppCreate;
  if (result.codeAppDiscount) return result.codeAppDiscount.discountId;

  // Shopify's actual wording/code for "this code is taken" isn't fully
  // pinned down (verify on a real store before relying on either match) —
  // check both a message match and the documented TAKEN error code so a
  // wording-only match failing doesn't throw for the whole shop's publish.
  const alreadyExists = result.userErrors.some(
    (e) => e.message.toLowerCase().includes("already") || e.code === "TAKEN",
  );
  if (!alreadyExists) {
    throw new Error(
      `discountCodeAppCreate failed: ${formatDiscountUserErrors(result.userErrors) || "Shopify returned no created discount"}`,
    );
  }

  const recoveredId = await findExistingCodeDiscount(
    shopDomain,
    accessToken,
    shopifyFunction.id,
    code,
  );
  if (!recoveredId) {
    throw new Error(
      `The code ${code} is already used by a Shopify discount this app doesn't manage. Delete or rename that discount in Shopify, then publish again. (${formatDiscountUserErrors(result.userErrors)})`,
    );
  }
  return recoveredId;
}

export async function updateCodeDiscountCombination(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
  options: CodeDiscountNodeOptions = {},
): Promise<void> {
  const data = await shopifyGraphQL<{
    discountCodeAppUpdate: {
      codeAppDiscount: { discountId: string } | null;
      userErrors: DiscountUserError[];
    };
  }>({
    shopDomain,
    accessToken,
    query: `mutation UpdatePromoEngineCodeDiscountCombination($id: ID!, $discount: DiscountCodeAppInput!) {
      discountCodeAppUpdate(id: $id, codeAppDiscount: $discount) {
        codeAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    variables: {
      id: discountId,
      discount: buildCodeDiscountUpdateInput(combinesWith, discountClasses, options),
    },
  });

  const result = data.discountCodeAppUpdate;
  if (result.userErrors.length > 0 || !result.codeAppDiscount) {
    const messages = formatDiscountUserErrors(result.userErrors);
    throw new Error(
      `discountCodeAppUpdate failed: ${messages || "Shopify returned no updated discount"}`,
    );
  }
}

/** Stops every code on the node from working without deleting the node or its codes. */
export async function expireCodeDiscountNode(
  shopDomain: string,
  accessToken: string,
  discountId: string,
): Promise<void> {
  const data = await shopifyGraphQL<{
    discountCodeAppUpdate: {
      codeAppDiscount: { discountId: string } | null;
      userErrors: DiscountUserError[];
    };
  }>({
    shopDomain,
    accessToken,
    query: `mutation ExpirePromoEngineCodeDiscount($id: ID!, $discount: DiscountCodeAppInput!) {
      discountCodeAppUpdate(id: $id, codeAppDiscount: $discount) {
        codeAppDiscount { discountId }
        userErrors { field message code }
      }
    }`,
    variables: { id: discountId, discount: { endsAt: new Date().toISOString() } },
  });
  const result = data.discountCodeAppUpdate;
  if (result.userErrors.length > 0 || !result.codeAppDiscount) {
    throw new Error(
      `discountCodeAppUpdate (expire) failed: ${formatDiscountUserErrors(result.userErrors) || "Shopify returned no updated discount"}`,
    );
  }
}

export async function deleteCodeDiscountNode(
  shopDomain: string,
  accessToken: string,
  discountId: string,
): Promise<void> {
  const data = await shopifyGraphQL<{
    discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: DiscountUserError[] };
  }>({
    shopDomain,
    accessToken,
    query: `mutation DeletePromoEngineCodeDiscount($id: ID!) {
      discountCodeDelete(id: $id) {
        deletedCodeDiscountId
        userErrors { field message code }
      }
    }`,
    variables: { id: discountId },
  });
  if (data.discountCodeDelete.userErrors.length > 0) {
    throw new Error(
      `discountCodeDelete failed: ${formatDiscountUserErrors(data.discountCodeDelete.userErrors)}`,
    );
  }
}

/** discountRedeemCodeBulkAdd accepts at most 250 codes per call. */
export const REDEEM_CODE_BATCH_SIZE = 250;
const BULK_POLL_INTERVAL_MS = 500;
const BULK_MAX_POLLS = 120;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Adds codes to a code discount node; resolves with the codes Shopify rejected (taken, invalid). */
export async function addRedeemCodes(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  codes: string[],
): Promise<Array<{ code: string; message: string }>> {
  const failed: Array<{ code: string; message: string }> = [];
  for (const batch of chunk(codes, REDEEM_CODE_BATCH_SIZE)) {
    const added = await shopifyGraphQL<{
      discountRedeemCodeBulkAdd: {
        bulkCreation: { id: string; done: boolean } | null;
        userErrors: DiscountUserError[];
      };
    }>({
      shopDomain,
      accessToken,
      query: `mutation AddPromoEngineRedeemCodes($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
        discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
          bulkCreation { id done }
          userErrors { field message code }
        }
      }`,
      variables: { discountId, codes: batch.map((code) => ({ code })) },
    });
    const payload = added.discountRedeemCodeBulkAdd;
    if (payload.userErrors.length > 0 || !payload.bulkCreation) {
      throw new Error(
        `discountRedeemCodeBulkAdd failed: ${formatDiscountUserErrors(payload.userErrors) || "Shopify returned no bulk creation"}`,
      );
    }
    for (let poll = 0; ; poll += 1) {
      const status = await shopifyGraphQL<{
        discountRedeemCodeBulkCreation: {
          done: boolean;
          codes: {
            nodes: Array<{ code: string; errors: Array<{ code: string; message: string }> }>;
          };
        } | null;
      }>({
        shopDomain,
        accessToken,
        query: `query PromoEngineRedeemCodeBulkCreation($id: ID!) {
          discountRedeemCodeBulkCreation(id: $id) {
            done
            codes(first: 250) { nodes { code errors { code message } } }
          }
        }`,
        variables: { id: payload.bulkCreation.id },
      });
      const creation = status.discountRedeemCodeBulkCreation;
      if (creation?.done) {
        for (const node of creation.codes.nodes) {
          const error = node.errors[0];
          if (error) failed.push({ code: node.code, message: error.message });
        }
        break;
      }
      if (poll >= BULK_MAX_POLLS) {
        throw new Error(
          "Timed out waiting for Shopify to finish adding discount codes. Publish again to retry.",
        );
      }
      await sleep(BULK_POLL_INTERVAL_MS);
    }
  }
  return failed;
}

/** Removes codes from a node. Codes Shopify no longer has are ignored. */
export async function removeRedeemCodes(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  codes: string[],
): Promise<void> {
  for (const group of chunk(codes, 50)) {
    const found = await shopifyGraphQL<{
      codeDiscountNode: {
        codeDiscount: { codes?: { nodes: Array<{ id: string; code: string }> } };
      } | null;
    }>({
      shopDomain,
      accessToken,
      query: `query FindPromoEngineRedeemCodes($id: ID!, $query: String) {
        codeDiscountNode(id: $id) {
          codeDiscount { ... on DiscountCodeApp { codes(first: 250, query: $query) { nodes { id code } } } }
        }
      }`,
      variables: {
        id: discountId,
        query: group.map((code) => `code:${code}`).join(" OR "),
      },
    });
    const wanted = new Set(group.map((code) => code.toUpperCase()));
    const ids = (found.codeDiscountNode?.codeDiscount.codes?.nodes ?? [])
      .filter((node) => wanted.has(node.code.toUpperCase()))
      .map((node) => node.id);
    for (const idBatch of chunk(ids, REDEEM_CODE_BATCH_SIZE)) {
      const deleted = await shopifyGraphQL<{
        discountCodeRedeemCodeBulkDelete: {
          job: { id: string } | null;
          userErrors: DiscountUserError[];
        };
      }>({
        shopDomain,
        accessToken,
        query: `mutation RemovePromoEngineRedeemCodes($discountId: ID!, $ids: [ID!]) {
          discountCodeRedeemCodeBulkDelete(discountId: $discountId, ids: $ids) {
            job { id }
            userErrors { field message code }
          }
        }`,
        variables: { discountId, ids: idBatch },
      });
      const payload = deleted.discountCodeRedeemCodeBulkDelete;
      if (payload.userErrors.length > 0) {
        throw new Error(
          `discountCodeRedeemCodeBulkDelete failed: ${formatDiscountUserErrors(payload.userErrors)}`,
        );
      }
      if (payload.job) await waitForJob(shopDomain, accessToken, payload.job.id);
    }
  }
}

async function waitForJob(shopDomain: string, accessToken: string, id: string): Promise<void> {
  for (let poll = 0; poll < BULK_MAX_POLLS; poll += 1) {
    const data = await shopifyGraphQL<{ job: { done: boolean } | null }>({
      shopDomain,
      accessToken,
      query: `query PromoEngineJob($id: ID!) { job(id: $id) { done } }`,
      variables: { id },
    });
    if (!data.job || data.job.done) return;
    await sleep(BULK_POLL_INTERVAL_MS);
  }
  throw new Error(
    "Timed out waiting for Shopify to finish removing discount codes. Publish again to retry.",
  );
}

async function readCodeNodeId(shopId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, CODE_NODE_SETTING)))
    .limit(1);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === "string" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** The shop's code-Function automatic node id, if one was ever created and still exists. */
export async function findCodeDiscountNode(
  shopId: string,
  shopDomain: string,
  accessToken: string,
): Promise<string | null> {
  const id = await readCodeNodeId(shopId);
  return id && (await discountNodeExists(shopDomain, accessToken, id)) ? id : null;
}

/**
 * Backend B: the single automatic app discount bound to the code Function,
 * which accepts the app's own codes. Created lazily the first time a code offer
 * needs it, and re-created if the merchant deleted it.
 */
export async function ensureCodeDiscountNode(
  shopId: string,
  shopDomain: string,
  accessToken: string,
): Promise<string> {
  const existing = await findCodeDiscountNode(shopId, shopDomain, accessToken);
  if (existing) return existing;

  const codeFunction = selectFunction(await findDiscountFunctions(shopDomain, accessToken), CODE_FUNCTION_TITLE);
  if (!codeFunction) {
    throw new Error(
      "Could not find the Promo Engine Code Discount Function. Deploy the current Shopify app version before enabling code backend B.",
    );
  }
  const id = await createOrFindAutomaticDiscount(
    shopDomain,
    accessToken,
    codeFunction,
    CODE_DISCOUNT_TITLE,
    CART_DISCOUNT_CLASSES,
  );
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: CODE_NODE_SETTING, value: JSON.stringify(id) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(id), updatedAt: new Date() },
    });
  return id;
}
