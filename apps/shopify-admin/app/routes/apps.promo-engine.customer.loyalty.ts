import type { LoaderFunctionArgs } from "react-router";
import { getSignedShopCached } from "../lib/proxy-shop.server.js";
import { proxyRateLimitResponse } from "../lib/proxy-rate-limit.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";
import { getSkioApiKey } from "../lib/skio-credentials.server.js";
import { getSkioCreditBalance, makeSkioGraphQLProxy } from "../lib/skio-api.server.js";

// Skio loyalty balance for the storefront cart drawer. The shop's Skio key is full-access, so it
// stays server-side; the customer is the signed logged_in_customer_id, so a visitor can only read
// their own balance. Any failure answers { balance: null } and the theme hides the line.
export const config = { maxDuration: 10 };

const SKIO_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; balance: unknown }>();

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await getSignedShopCached(request);
    const customerId = shop.loggedInCustomerId;
    if (!customerId || !/^\d+$/.test(customerId)) return apiJson(request, { balance: null });

    const limited = await proxyRateLimitResponse(request, "customer-loyalty", shop.id, 30);
    if (limited) return limited;

    const key = `${shop.id}:${customerId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return apiJson(request, { balance: hit.balance });

    const apiKey = await getSkioApiKey(shop.db, shop.id);
    if (!apiKey) return apiJson(request, { balance: null });

    let balance = null;
    try {
      const result = await getSkioCreditBalance(makeSkioGraphQLProxy(apiKey, SKIO_TIMEOUT_MS), `gid://shopify/Customer/${customerId}`);
      balance = result
        ? { credits: result.credits, value: result.siteCurrencyValue, formatted: result.siteCurrencyStringValue }
        : null;
    } catch (error) {
      console.warn("[apps.promo-engine.customer.loyalty] Skio balance lookup failed", error);
    }

    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, balance });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return apiJson(request, { balance });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.customer.loyalty");
  }
}
