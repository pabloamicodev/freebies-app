/**
 * Resolves the storefront visitor's customer record for offer evaluation.
 * The id comes from `logged_in_customer_id` on the App Proxy request, which
 * Shopify signs itself — the storefront runtime cannot forge or choose it.
 */
import type { NormalizedCustomer } from "@promo/shared-types";
import { decryptToken } from "./token-crypto.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import { getSharedRedis, recordRedisFailure, resetSharedRedis } from "./redis.server.js";

// Tags/spend/location rarely change within a shopping session, so a short
// cache lets repeat cart-evaluation calls for the same customer skip the
// Admin API round trip entirely. Long enough to matter across a session's
// worth of add-to-cart calls, short enough that stale profiles don't linger.
const CACHE_TTL_SECONDS = 45;

// Sentinel wrapper so a resolved-to-null profile (guest, deleted customer,
// lookup failure) can be cached too — otherwise those lookups would hit the
// Admin API on every single request, same as an uncached miss.
interface CachedProfile {
  profile: NormalizedCustomer | null;
}

function cacheKeyFor(shopDomain: string, customerId: string): string {
  return `customer-profile:${shopDomain}:${customerId}`;
}

async function readCachedProfile(key: string): Promise<NormalizedCustomer | null | undefined> {
  const redis = await getSharedRedis();
  if (!redis) return undefined;

  try {
    const raw = (await redis.eval("return redis.call('GET', KEYS[1])", 1, key)) as string | null;
    if (raw == null) return undefined;
    const cached = JSON.parse(raw) as CachedProfile;
    return cached.profile;
  } catch {
    recordRedisFailure();
    resetSharedRedis();
    return undefined;
  }
}

async function writeCachedProfile(key: string, profile: NormalizedCustomer | null): Promise<void> {
  const redis = await getSharedRedis();
  if (!redis) return;

  try {
    const value: CachedProfile = { profile };
    await redis.eval(
      "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
      1,
      key,
      JSON.stringify(value),
      CACHE_TTL_SECONDS,
    );
  } catch {
    recordRedisFailure();
    resetSharedRedis();
  }
}

interface CustomerQueryResult {
  customer: {
    id: string;
    tags: string[];
    numberOfOrders: string;
    amountSpent: { amount: string };
    defaultAddress: { countryCodeV2: string | null } | null;
    lastOrder: { nodes: Array<{ totalPriceSet: { shopMoney: { amount: string } } }> };
  } | null;
}

export async function resolveCustomer(
  shopDomain: string,
  accessTokenEncrypted: string,
  loggedInCustomerId: string | null,
): Promise<NormalizedCustomer | null> {
  if (!loggedInCustomerId || !/^\d+$/.test(loggedInCustomerId)) return null;

  const cacheKey = cacheKeyFor(shopDomain, loggedInCustomerId);
  const cached = await readCachedProfile(cacheKey);
  if (cached !== undefined) return cached;

  const profile = await fetchCustomerProfile(shopDomain, accessTokenEncrypted, loggedInCustomerId);
  await writeCachedProfile(cacheKey, profile);
  return profile;
}

async function fetchCustomerProfile(
  shopDomain: string,
  accessTokenEncrypted: string,
  loggedInCustomerId: string,
): Promise<NormalizedCustomer | null> {
  const accessToken = await decryptToken(accessTokenEncrypted);
  const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;

  try {
    const data = await shopifyGraphQL<CustomerQueryResult>({
      shopDomain,
      accessToken,
      query: `query CustomerForEvaluation($id: ID!) {
        customer(id: $id) {
          id
          tags
          numberOfOrders
          amountSpent { amount }
          defaultAddress { countryCodeV2 }
          lastOrder: orders(first: 1, sortKey: CREATED_AT, reverse: true) {
            nodes { totalPriceSet { shopMoney { amount } } }
          }
        }
      }`,
      variables: { id: customerGid },
      // This runs inline on the evaluate hot path — a slow/throttled Admin API
      // call here must fail fast (falling back to `null`) rather than making
      // every add-to-cart on the storefront wait on retries/backoff.
      maxRetries: 0,
      timeoutMs: 1_500,
      skipThrottleBackoff: true,
    });

    const customer = data.customer;
    if (!customer) return null;

    const totalSpentCents = Math.round(parseFloat(customer.amountSpent.amount) * 100);
    const totalOrders = Number.parseInt(customer.numberOfOrders, 10) || 0;
    const lastOrderAmount = customer.lastOrder.nodes[0]?.totalPriceSet.shopMoney.amount;

    return {
      id: customer.id,
      email: null,
      tags: customer.tags,
      totalSpentCents: Number.isFinite(totalSpentCents) ? totalSpentCents : 0,
      totalOrders,
      lastOrderSpentCents: lastOrderAmount ? Math.round(parseFloat(lastOrderAmount) * 100) : null,
      countryCode: customer.defaultAddress?.countryCodeV2 ?? null,
      isFirstTimeCustomer: totalOrders === 0,
    };
  } catch (err) {
    console.error("[resolve-customer] Failed to fetch customer from Admin API:", err instanceof Error ? err.message : err);
    return null;
  }
}
