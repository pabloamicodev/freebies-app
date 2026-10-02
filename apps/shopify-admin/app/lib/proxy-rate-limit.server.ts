import { checkRateLimit, envLimit, jitteredRetryAfter } from "./rate-limit.server.js";
import { apiError } from "./api-response.server.js";

/**
 * 429 response when an app-proxy caller exceeds its budget for `scope`, else null.
 * Call only after the proxy signature was verified (getSignedShop*), because the customer id
 * below is trusted only then.
 *
 * Never keyed by IP: behind the app proxy the address is Shopify's, which merges every visitor
 * into one bucket. Limits are a shop-wide ceiling (`shopLimit`, fixed window) and, for logged-in
 * visitors, a per-customer limit (`limit` per minute).
 *
 * The shop ceiling is overridable per project with `<SCOPE>_SHOP_LIMIT_PER_MINUTE` (scope upper-cased,
 * `-` as `_`: BUNDLE_SHOP_LIMIT_PER_MINUTE, PRODUCT_CUSTOMIZATIONS_SHOP_LIMIT_PER_MINUTE), and it is skipped when
 * Redis is down so the cap cannot turn into one hot `rate_limits` row per shop.
 */
export async function proxyRateLimitResponse(
  request: Request,
  scope: string,
  shopId: string,
  limit: number,
  shopLimit: number = limit * 50,
): Promise<Response | null> {
  const ceiling = envLimit(`${scope.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SHOP_LIMIT_PER_MINUTE`, shopLimit);
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  const [shopResult, customerResult] = await Promise.all([
    checkRateLimit(`${scope}:${shopId}`, { limit: ceiling, windowMs: 60_000, fixedWindow: true, onRedisUnavailable: "skip" }),
    customerId && /^\d+$/.test(customerId)
      ? checkRateLimit(`${scope}:${shopId}:c:${customerId}`, { limit, windowMs: 60_000 })
      : Promise.resolve({ ok: true as const }),
  ]);
  const blocked = !shopResult.ok ? shopResult : !customerResult.ok ? customerResult : null;
  if (!blocked) return null;
  return apiError(request, {
    status: 429,
    code: "RATE_LIMITED",
    message: "Too many requests.",
    retryable: true,
    retryAfterSeconds: jitteredRetryAfter(blocked.retryAfterSeconds),
  });
}
