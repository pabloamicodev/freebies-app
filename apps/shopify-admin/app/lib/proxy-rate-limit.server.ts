import { checkRateLimit, getClientIp } from "./rate-limit.server.js";
import { apiError } from "./api-response.server.js";

/** 429 response when an app-proxy caller exceeds `limit` requests per minute for `scope`, else null. */
export async function proxyRateLimitResponse(
  request: Request,
  scope: string,
  shopId: string,
  limit: number,
): Promise<Response | null> {
  const rateLimit = await checkRateLimit(`${scope}:${shopId}:${getClientIp(request)}`, { limit, windowMs: 60_000 });
  if (rateLimit.ok) return null;
  return apiError(request, {
    status: 429,
    code: "RATE_LIMITED",
    message: "Too many requests.",
    retryable: true,
    retryAfterSeconds: rateLimit.retryAfterSeconds,
  });
}
