import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getSignedShopCached } from "../lib/proxy-shop.server.js";
import { proxyRateLimitResponse } from "../lib/proxy-rate-limit.server.js";
import { apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";
import { getSkioApiKey } from "../lib/skio-credentials.server.js";
import {
  getSkioCreditBalance,
  getSkioStorefrontUserPlatformId,
  makeSkioGraphQLProxy,
  type SkioCustomerRef,
} from "../lib/skio-api.server.js";
import { verifySkioIdToken } from "../lib/skio-cognito.server.js";
import { shopifyGraphQL } from "../lib/shopify-fetch.server.js";
import { decryptToken } from "../lib/token-crypto.server.js";

// Skio loyalty line for the storefront cart drawer: { balance, tier } for the visitor.
// Identity is either Shopify's signed logged_in_customer_id (GET) or, for stores where customers
// only sign in through Skio, the Skio Cognito ID token from the browser (POST { idToken }),
// verified server-side. The shop's Skio key is full-access, so it never leaves the server.
// Any failure answers { balance: null, tier: null } and the theme hides the line.
export const config = { maxDuration: 10 };

const SKIO_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 60_000;
const EMPTY = { balance: null, tier: null };
const cache = new Map<string, { expiresAt: number; body: unknown }>();

type Shop = Awaited<ReturnType<typeof getSignedShopCached>>;

async function customerTier(shop: Shop, customerGid: string): Promise<string | null> {
  const data = await shopifyGraphQL<{ customer: { tags: string[] } | null }>({
    shopDomain: shop.shopDomain,
    accessToken: await decryptToken(shop.accessTokenEncrypted),
    query: "query LoyaltyTier($id: ID!) { customer(id: $id) { tags } }",
    variables: { id: customerGid },
    maxRetries: 1,
    timeoutMs: 2500,
  });
  const tag = data.customer?.tags.find((t) => /^SKIO_LOYALTY:/i.test(t));
  return tag ? tag.replace(/^SKIO_LOYALTY:/i, "").trim() || null : null;
}

async function resolve(request: Request, shop: Shop, identity: { shopifyCustomerId?: string; storefrontUserId?: string }) {
  const key = `${shop.id}:${identity.shopifyCustomerId ?? `s:${identity.storefrontUserId}`}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return apiJson(request, hit.body);

  const apiKey = await getSkioApiKey(shop.db, shop.id);
  if (!apiKey) return apiJson(request, EMPTY);

  let body: unknown = EMPTY;
  try {
    const skio = makeSkioGraphQLProxy(apiKey, SKIO_TIMEOUT_MS);
    const ref: SkioCustomerRef = identity.shopifyCustomerId
      ? { platformId: `gid://shopify/Customer/${identity.shopifyCustomerId}` }
      : { storefrontUserId: identity.storefrontUserId! };
    const [balance, platformId] = await Promise.all([
      getSkioCreditBalance(skio, ref),
      "platformId" in ref ? ref.platformId : getSkioStorefrontUserPlatformId(skio, ref.storefrontUserId),
    ]);
    if (balance) {
      const tier = platformId ? await customerTier(shop, platformId).catch(() => null) : null;
      body = {
        balance: { credits: balance.credits, value: balance.siteCurrencyValue, formatted: balance.siteCurrencyStringValue },
        tier,
      };
    }
  } catch (error) {
    console.warn("[apps.promo-engine.customer.loyalty] lookup failed", error);
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, body });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return apiJson(request, body);
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await getSignedShopCached(request);
    const customerId = shop.loggedInCustomerId;
    if (!customerId || !/^\d+$/.test(customerId)) return apiJson(request, EMPTY);
    const limited = await proxyRateLimitResponse(request, "customer-loyalty", shop.id, 30);
    if (limited) return limited;
    return await resolve(request, shop, { shopifyCustomerId: customerId });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.customer.loyalty");
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const shop = await getSignedShopCached(request);
    const limited = await proxyRateLimitResponse(request, "customer-loyalty", shop.id, 30);
    if (limited) return limited;
    const customerId = shop.loggedInCustomerId;
    if (customerId && /^\d+$/.test(customerId)) return await resolve(request, shop, { shopifyCustomerId: customerId });

    const { idToken } = await readJsonBody<{ idToken?: unknown }>(request, { maxBytes: 16_384 });
    const storefrontUserId = typeof idToken === "string" ? await verifySkioIdToken(idToken) : null;
    if (!storefrontUserId) return apiJson(request, EMPTY);
    return await resolve(request, shop, { storefrontUserId });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.customer.loyalty");
  }
}
