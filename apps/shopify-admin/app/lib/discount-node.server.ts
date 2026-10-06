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
import { ShopifyOutcomeUnknownError, shopifyGraphQL } from "./shopify-fetch.server.js";

const CART_DISCOUNT_TITLE = "Promo Engine";
const DELIVERY_DISCOUNT_TITLE = "Promo Engine Shipping";
export const CART_FUNCTION_TITLE = "Promo Engine Discount";
export const DELIVERY_FUNCTION_TITLE = "Promo Engine Delivery Discount";
export const CODE_FUNCTION_TITLE = "Promo Engine Code Discount";
const CODE_DISCOUNT_TITLE = "Promo Engine Codes";
export const CODE_NODE_SETTING = "code_discount_node.id";
/** Automatic delivery nodes that carry the code-gated shipping of mixed code offers (hashes live there, not in the shared delivery config). */
export const CODED_SHIPPING_TITLE_PREFIX = "Promo Engine Coded Shipping";
export const CODED_SHIPPING_POOL_SETTING = "coded_shipping_pool.ids";
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
    retryable: true,
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

/**
 * Shopify skips an app discount on selling-plan (subscription) lines unless the node has
 * appliesOnSubscription. The default only flipped to true in API 2026-07, so older nodes can carry
 * false: always send both flags. Shared nodes stay true/true (the Function filters per offer through
 * subscriptionMode); per-offer code nodes follow the offer's reward modes.
 * recurringCycleLimit is deliberately left at Shopify's default (the first billing cycle).
 */
export interface PurchaseTypeFlags {
  appliesOnSubscription: boolean;
  appliesOnOneTimePurchase: boolean;
}

export const ALL_PURCHASE_TYPES: PurchaseTypeFlags = {
  appliesOnSubscription: true,
  appliesOnOneTimePurchase: true,
};

export function purchaseTypeFlags(modes: ReadonlyArray<string | null | undefined>): PurchaseTypeFlags {
  if (modes.length === 0) return ALL_PURCHASE_TYPES;
  return {
    appliesOnSubscription: modes.some((mode) => mode !== "one_time_only"),
    appliesOnOneTimePurchase: modes.some((mode) => mode !== "subscription_only"),
  };
}

export function buildAutomaticDiscountCreateInput(
  functionHandle: string,
  title: string,
  discountClasses: readonly DiscountClass[],
  startsAt = new Date().toISOString(),
  purchaseTypes: PurchaseTypeFlags = ALL_PURCHASE_TYPES,
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
    ...purchaseTypes,
  };
}

export function buildAutomaticDiscountUpdateInput(
  combinesWith: DiscountCombinationPolicyInput,
  discountClasses: readonly DiscountClass[],
  purchaseTypes: PurchaseTypeFlags = ALL_PURCHASE_TYPES,
) {
  return {
    combinesWith: normalizeDiscountCombinationPolicy(combinesWith, discountClasses),
    discountClasses: [...discountClasses],
    ...purchaseTypes,
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

/** Reuses an existing automatic discount if one is already registered (e.g. a previous
 * afterAuth run failed after creating it but before we could persist the id) — avoids
 * creating duplicates on retry. A create that times out is never re-sent blind: the
 * lookup runs first, since the node may already exist. */
export async function createOrFindAutomaticDiscount(
  shopDomain: string,
  accessToken: string,
  shopifyFunction: ShopifyFunctionSummary,
  title: string,
  discountClasses: readonly DiscountClass[],
  match: AutomaticDiscountMatch = { functionId: shopifyFunction.id, title },
): Promise<string> {
  const existingId = await findExistingAutomaticDiscount(shopDomain, accessToken, match);
  if (existingId) return existingId;

  const create = () =>
    shopifyGraphQL<{
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
  let created: Awaited<ReturnType<typeof create>>;
  try {
    created = await create();
  } catch (err) {
    if (!(err instanceof ShopifyOutcomeUnknownError)) throw err;
    const recovered = await findExistingAutomaticDiscount(shopDomain, accessToken, match);
    if (recovered) return recovered;
    // Looked and it isn't there: the first attempt didn't land, so one more is safe.
    created = await create();
  }

  const result = created.discountAutomaticAppCreate;
  if (result.automaticAppDiscount) return result.automaticAppDiscount.discountId;

  const alreadyExists = result.userErrors.some((e) => e.message.toLowerCase().includes("already"));
  if (!alreadyExists) {
    throw new Error(
      `discountAutomaticAppCreate failed: ${formatDiscountUserErrors(result.userErrors) || "Shopify returned no created discount"}`,
    );
  }

  const recoveredId = await findExistingAutomaticDiscount(shopDomain, accessToken, match);
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
/** Narrows the scan to automatic discounts so a shop with thousands of code discounts still finds ours. */
export const AUTOMATIC_DISCOUNT_QUERY = "method:automatic";

interface DiscountNodesPage {
  discountNodes: {
    nodes: Array<{
      id: string;
      discount: {
        __typename: string;
        title?: string;
        appDiscountType?: { functionId: string };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function fetchDiscountNodesPage(
  shopDomain: string,
  accessToken: string,
  cursor: string | null,
  query: string | null,
): Promise<DiscountNodesPage> {
  return shopifyGraphQL<DiscountNodesPage>({
    shopDomain,
    accessToken,
    query: `query FindExistingAppDiscount($first: Int!, $after: String, $query: String) {
      discountNodes(first: $first, after: $after, query: $query) {
        nodes {
          id
          discount {
            __typename
            ... on DiscountAutomaticApp { title appDiscountType { functionId } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    variables: { first: DISCOUNT_NODES_PAGE_SIZE, after: cursor, query },
  });
}

export interface AutomaticDiscountMatch {
  functionId: string;
  title: string;
  /** Only an exact (case-insensitive) title match counts, e.g. for the coded shipping pool nodes. */
  exactTitle?: boolean;
}

const normalizedTitle = (title: string | undefined) => (title ?? "").trim().toLocaleLowerCase();

async function scanAutomaticDiscounts(
  shopDomain: string,
  accessToken: string,
  match: AutomaticDiscountMatch,
  query: string | null,
): Promise<string | null> {
  // The delivery Function backs both the shared shipping node and the coded shipping pool,
  // so a function-only match must never pick a pool node.
  const wanted = normalizedTitle(match.title);
  const poolPrefix = normalizedTitle(CODED_SHIPPING_TITLE_PREFIX);
  let fallback: string | null = null;
  let cursor: string | null = null;
  // Paginate instead of trusting the first 50 — a shop with many discounts (legacy or from
  // other apps) could push ours past that window, and a second run would create a duplicate.
  for (let page = 0; page < DISCOUNT_NODES_MAX_PAGES; page += 1) {
    const data: DiscountNodesPage = await fetchDiscountNodesPage(shopDomain, accessToken, cursor, query);
    for (const node of data.discountNodes.nodes) {
      if (node.discount.__typename !== "DiscountAutomaticApp") continue;
      if (node.discount.appDiscountType?.functionId !== match.functionId) continue;
      const title = normalizedTitle(node.discount.title);
      if (title === wanted) return node.id;
      if (!match.exactTitle && !title.startsWith(poolPrefix)) fallback ??= node.id;
    }
    const pageInfo = data.discountNodes.pageInfo;
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return fallback;
}

async function findExistingAutomaticDiscount(
  shopDomain: string,
  accessToken: string,
  match: AutomaticDiscountMatch,
): Promise<string | null> {
  // Filtered first. The unfiltered scan stays as a fallback: a search term Shopify doesn't
  // recognise returns nothing rather than an error.
  return (
    (await scanAutomaticDiscounts(shopDomain, accessToken, match, AUTOMATIC_DISCOUNT_QUERY)) ??
    (await scanAutomaticDiscounts(shopDomain, accessToken, match, null))
  );
}

/** Our DiscountCodeApp node holding `code`: an exact lookup, since codes are unique per shop
 * (Shopify matches them case-insensitively; `code` is already the normalized stored value). */
async function findExistingCodeDiscount(
  shopDomain: string,
  accessToken: string,
  functionId: string,
  code: string,
): Promise<string | null> {
  const data = await shopifyGraphQL<{
    codeDiscountNodeByCode: {
      id: string;
      codeDiscount: { __typename: string; appDiscountType?: { functionId: string } } | null;
    } | null;
  }>({
    shopDomain,
    accessToken,
    query: `query FindExistingCodeDiscount($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount { __typename ... on DiscountCodeApp { appDiscountType { functionId } } }
      }
    }`,
    variables: { code: code.trim().toUpperCase() },
  });
  const node = data.codeDiscountNodeByCode;
  return node?.codeDiscount?.__typename === "DiscountCodeApp" &&
    node.codeDiscount.appDiscountType?.functionId === functionId
    ? node.id
    : null;
}

export interface CodeDiscountNodeOptions {
  /** Node-wide cap, shared by every code on the node. */
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  /** Set to expire the node (no code on it works); null reopens it. */
  endsAt?: string | null;
  /** Defaults to both purchase types. */
  purchaseTypes?: PurchaseTypeFlags;
}

function codeNodeOptionFields(options: CodeDiscountNodeOptions) {
  return {
    ...(options.purchaseTypes ?? ALL_PURCHASE_TYPES),
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
  const create = () =>
    shopifyGraphQL<{
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
  let created: Awaited<ReturnType<typeof create>>;
  try {
    created = await create();
  } catch (err) {
    // A timed-out create may have gone through: look before sending it again.
    if (!(err instanceof ShopifyOutcomeUnknownError)) throw err;
    const recovered = await findExistingCodeDiscount(shopDomain, accessToken, shopifyFunction.id, code);
    if (recovered) return recovered;
    created = await create();
  }

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
    retryable: true,
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
    retryable: true,
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
    retryable: true,
    query: `mutation DeletePromoEngineCodeDiscount($id: ID!) {
      discountCodeDelete(id: $id) {
        deletedCodeDiscountId
        userErrors { field message code }
      }
    }`,
    variables: { id: discountId },
  });
  // A retry after a delete that landed finds the node gone, which is the state we wanted.
  if (data.discountCodeDelete.userErrors.some((error) => !/not exist|not found/i.test(error.message))) {
    throw new Error(
      `discountCodeDelete failed: ${formatDiscountUserErrors(data.discountCodeDelete.userErrors)}`,
    );
  }
}

/** discountRedeemCodeBulkAdd accepts at most 250 codes per call. */
export const REDEEM_CODE_BATCH_SIZE = 250;
const BULK_POLL_INTERVAL_MS = 500;
const BULK_MAX_POLLS = 120;
/** Pause before re-checking what an unknown-outcome bulk add left on the node (the job is async). */
const UNKNOWN_OUTCOME_SETTLE_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Search term matching exactly one code; quoted so "-", ":" or spaces aren't parsed as search syntax. */
export function codeSearchTerm(code: string): string {
  return `code:"${code.replace(/["\\]/g, "\\$&")}"`;
}

/** Which discount node holds each code right now (null: no discount has it). Keys are the codes as given. */
export async function codeOwners(
  shopDomain: string,
  accessToken: string,
  codes: string[],
): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  for (const group of chunk([...new Set(codes)], 40)) {
    const variableDefs = group.map((_, i) => `$c${i}: String!`).join(", ");
    const fields = group.map((_, i) => `c${i}: codeDiscountNodeByCode(code: $c${i}) { id }`).join("\n");
    const data = await shopifyGraphQL<Record<string, { id: string } | null>>({
      shopDomain,
      accessToken,
      query: `query PromoEngineCodeOwners(${variableDefs}) {\n${fields}\n}`,
      variables: Object.fromEntries(group.map((code, i) => [`c${i}`, code])),
    });
    group.forEach((code, i) => owners.set(code, data[`c${i}`]?.id ?? null));
  }
  return owners;
}

/** Adds codes to a code discount node; resolves with the codes Shopify rejected (taken, invalid). */
export async function addRedeemCodes(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  codes: string[],
): Promise<Array<{ code: string; message: string }>> {
  const failed: Array<{ code: string; message: string }> = [];
  const submit = (batch: string[]) =>
    shopifyGraphQL<{
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

  for (const original of chunk(codes, REDEEM_CODE_BATCH_SIZE)) {
    let batch = original;
    let added: Awaited<ReturnType<typeof submit>> | null = null;
    try {
      added = await submit(batch);
    } catch (err) {
      if (!(err instanceof ShopifyOutcomeUnknownError)) throw err;
      // The bulk job may be running. Codes are unique per shop, so re-sending is safe from
      // duplicates, but look first: only codes that aren't there yet go out again, and a code
      // another discount took is reported like any other rejection.
      await sleep(UNKNOWN_OUTCOME_SETTLE_MS);
      const owners = await codeOwners(shopDomain, accessToken, batch);
      const absent: string[] = [];
      for (const code of batch) {
        const owner = owners.get(code) ?? null;
        if (owner === null) absent.push(code);
        else if (owner !== discountId) {
          failed.push({ code, message: "That code is already used by another discount." });
        }
      }
      batch = absent;
      if (batch.length === 0) continue;
      added = await submit(batch);
    }
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

export interface RemoveRedeemCodesResult {
  /** Gone from the node, confirmed by a lookup after the delete. */
  removed: string[];
  /** Confirmed not on this node (Shopify has no such code, or another discount holds it). */
  absent: string[];
  /** Still on the node as far as Shopify says (search missed it, or the delete didn't take): NOT removed. */
  unconfirmed: string[];
}

/**
 * Removes codes from a node and reports what actually happened to each one, so callers only
 * treat a code as gone once Shopify confirms it. Throws on Shopify user errors.
 */
export async function removeRedeemCodes(
  shopDomain: string,
  accessToken: string,
  discountId: string,
  codes: string[],
): Promise<RemoveRedeemCodesResult> {
  const result: RemoveRedeemCodesResult = { removed: [], absent: [], unconfirmed: [] };
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
        query: group.map(codeSearchTerm).join(" OR "),
      },
    });
    const wanted = new Set(group.map((code) => code.toUpperCase()));
    const matches = (found.codeDiscountNode?.codeDiscount.codes?.nodes ?? []).filter((node) =>
      wanted.has(node.code.toUpperCase()),
    );
    const foundCodes = new Set(matches.map((node) => node.code.toUpperCase()));
    const missing = group.filter((code) => !foundCodes.has(code.toUpperCase()));
    if (missing.length > 0) {
      const owners = await codeOwners(shopDomain, accessToken, missing);
      for (const code of missing) {
        if (owners.get(code) === discountId) result.unconfirmed.push(code);
        else result.absent.push(code);
      }
    }

    const attempted = group.filter((code) => foundCodes.has(code.toUpperCase()));
    for (const idBatch of chunk(
      matches.map((node) => node.id),
      REDEEM_CODE_BATCH_SIZE,
    )) {
      try {
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
      } catch (err) {
        // Outcome unknown: the verification below decides what is still on the node.
        if (!(err instanceof ShopifyOutcomeUnknownError)) throw err;
      }
    }
    if (attempted.length === 0) continue;
    const after = await codeOwners(shopDomain, accessToken, attempted);
    for (const code of attempted) {
      if (after.get(code) === discountId) result.unconfirmed.push(code);
      else result.removed.push(code);
    }
  }
  return result;
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

/** Which of these discount node ids (automatic or code) still exist in Shopify. */
export async function existingDiscountNodeIds(
  shopDomain: string,
  accessToken: string,
  ids: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunk([...new Set(ids)], 100)) {
    const data = await shopifyGraphQL<{
      nodes: Array<{ id?: string } | null>;
    }>({
      shopDomain,
      accessToken,
      query: `query PromoEngineNodesExist($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountAutomaticNode { id }
          ... on DiscountCodeNode { id }
        }
      }`,
      variables: { ids: group },
    });
    for (const node of data.nodes) if (node?.id) found.add(node.id);
  }
  return found;
}

/** Live automatic nodes among `ids`, with their titles (null when Shopify returns none). */
async function automaticNodeTitles(
  shopDomain: string,
  accessToken: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (const group of chunk([...new Set(ids)], 100)) {
    const data = await shopifyGraphQL<{
      nodes: Array<{ id?: string; automaticDiscount?: { title?: string } | null } | null>;
    }>({
      shopDomain,
      accessToken,
      query: `query PromoEngineNodesExist($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountAutomaticNode { id automaticDiscount { ... on DiscountAutomaticApp { title } } }
          ... on DiscountCodeNode { id }
        }
      }`,
      variables: { ids: group },
    });
    for (const node of data.nodes) if (node?.id) found.set(node.id, node.automaticDiscount?.title ?? null);
  }
  return found;
}

/** Slot number of a pool node title ("Promo Engine Coded Shipping 3" -> 3), or null for any other title. */
function codedShippingSlot(title: string | null | undefined): number | null {
  const match = new RegExp(`^${CODED_SHIPPING_TITLE_PREFIX} (\\d+)$`, "i").exec((title ?? "").trim());
  return match ? Number(match[1]) : null;
}

export async function deleteAutomaticDiscountNode(
  shopDomain: string,
  accessToken: string,
  discountId: string,
): Promise<void> {
  const data = await shopifyGraphQL<{
    discountAutomaticDelete: { deletedAutomaticDiscountId: string | null; userErrors: DiscountUserError[] };
  }>({
    shopDomain,
    accessToken,
    retryable: true,
    query: `mutation DeletePromoEngineAutomaticDiscount($id: ID!) {
      discountAutomaticDelete(id: $id) {
        deletedAutomaticDiscountId
        userErrors { field message code }
      }
    }`,
    variables: { id: discountId },
  });
  // A retry after a delete that landed finds the node gone, which is the state we wanted.
  if (data.discountAutomaticDelete.userErrors.some((error) => !/not exist|not found/i.test(error.message))) {
    throw new Error(
      `discountAutomaticDelete failed: ${formatDiscountUserErrors(data.discountAutomaticDelete.userErrors)}`,
    );
  }
}

export async function readCodedShippingNodeIds(shopId: string): Promise<string[]> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, CODED_SHIPPING_POOL_SETTING)))
    .limit(1);
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writeCodedShippingNodeIds(shopId: string, ids: string[]): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: CODED_SHIPPING_POOL_SETTING, value: JSON.stringify(ids) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(ids), updatedAt: new Date() },
    });
}

/** Shopify allows this many active automatic discounts per shop, across every app. */
export const SHOPIFY_AUTOMATIC_DISCOUNT_LIMIT = 25;

/** Merchant-facing: the shop has no room under Shopify's automatic-discount limit for the nodes we need. */
export class AutomaticDiscountLimitError extends Error {
  constructor(
    readonly active: number,
    readonly wanted: number,
  ) {
    super(
      `Free shipping on code offers needs ${wanted} more automatic discount${wanted === 1 ? "" : "s"} in Shopify, but your store already has ${active} active and Shopify allows ${SHOPIFY_AUTOMATIC_DISCOUNT_LIMIT}. Deactivate or delete some automatic discounts in Shopify, then publish again.`,
    );
    this.name = "AutomaticDiscountLimitError";
  }
}

/** Active automatic discounts in the shop (all apps), or null when Shopify can't say: the check is best effort. */
export async function countActiveAutomaticDiscounts(
  shopDomain: string,
  accessToken: string,
): Promise<number | null> {
  try {
    const data = await shopifyGraphQL<{ discountNodesCount: { count: number } | null }>({
      shopDomain,
      accessToken,
      query: `query PromoEngineAutomaticDiscountCount($query: String) {
        discountNodesCount(query: $query, limit: 100) { count }
      }`,
      variables: { query: "method:automatic AND status:active" },
    });
    return data.discountNodesCount?.count ?? null;
  } catch (error) {
    if (error instanceof ShopifyOutcomeUnknownError) throw error;
    return null;
  }
}

/** Most automatic delivery nodes a shop may dedicate to code-gated shipping (Shopify caps automatic discounts at 25 per shop). */
export const MAX_CODED_SHIPPING_NODES = 12;

/**
 * The shop's pool of automatic delivery nodes for the shipping part of mixed code offers.
 * Returns exactly `needed` live node ids: missing ones (deleted by the merchant, or lost on
 * reinstall) are created, and surplus ones are deleted so they don't count against Shopify's
 * automatic-discount limit. Each node is created at most once: ids are persisted after every
 * create and a timed-out create is looked up by title before it is repeated.
 */
export async function ensureCodedShippingNodes(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  needed: number,
): Promise<string[]> {
  if (needed > MAX_CODED_SHIPPING_NODES) {
    throw new Error(
      `Code-gated shipping needs ${needed} delivery discounts, more than the ${MAX_CODED_SHIPPING_NODES} this app may use. Reduce the number of codes on offers with free shipping.`,
    );
  }
  const stored = await readCodedShippingNodeIds(shopId);
  const live = stored.length > 0 ? await automaticNodeTitles(shopDomain, accessToken, stored) : new Map<string, string | null>();
  const kept = stored.filter((id) => live.has(id));
  const surplus = kept.slice(needed);
  const ids = kept.slice(0, needed);

  if (ids.length < needed) {
    const active = await countActiveAutomaticDiscounts(shopDomain, accessToken);
    if (active !== null && active + (needed - ids.length) > SHOPIFY_AUTOMATIC_DISCOUNT_LIMIT) {
      throw new AutomaticDiscountLimitError(active, needed - ids.length);
    }
    const deliveryFunction = await findDeliveryDiscountFunction(shopDomain, accessToken);
    // Titles come from the nodes that actually exist: after the merchant deletes node 2 of 1..3,
    // "count + 1" would be 3 again, and the exact-title lookup would hand back node 3's id twice.
    const usedSlots = new Set(
      ids.flatMap((id) => {
        const slot = codedShippingSlot(live.get(id));
        return slot === null ? [] : [slot];
      }),
    );
    // Surplus nodes are deleted below, so their titles are still taken while this publish runs.
    for (const id of surplus) {
      const slot = codedShippingSlot(live.get(id));
      if (slot !== null) usedSlots.add(slot);
    }
    for (let created = ids.length; created < needed; created += 1) {
      let slot = 1;
      while (usedSlots.has(slot)) slot += 1;
      usedSlots.add(slot);
      const title = `${CODED_SHIPPING_TITLE_PREFIX} ${slot}`;
      const id = await createOrFindAutomaticDiscount(
        shopDomain,
        accessToken,
        deliveryFunction,
        title,
        DELIVERY_DISCOUNT_CLASSES,
        { functionId: deliveryFunction.id, title, exactTitle: true },
      );
      if (ids.includes(id)) {
        throw new Error(`Coded shipping slot "${title}" resolved to a node that is already in the pool (${id}).`);
      }
      ids.push(id);
      await writeCodedShippingNodeIds(shopId, ids);
    }
  }
  if (ids.length !== stored.length || ids.some((id, i) => stored[i] !== id)) {
    await writeCodedShippingNodeIds(shopId, ids);
  }
  for (const id of surplus) await deleteAutomaticDiscountNode(shopDomain, accessToken, id);
  return ids;
}
