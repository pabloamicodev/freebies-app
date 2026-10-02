import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";
import { ReportErrorRequestSchema } from "@promo/shared-types";
import { apiError, apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";

const MAX_REPORT_BYTES = 16 * 1024;
const GLOBAL_LIMIT_PER_MINUTE = 120;
const SHOP_LIMIT_PER_MINUTE = 30;
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The embedded admin URL carries `shop`; it is a claim, used only to meter, never to authorize. */
function shopFromRequest(request: Request): string | null {
  const shop = new URL(request.url).searchParams.get("shop")?.toLowerCase() ?? "";
  return SHOP_DOMAIN.test(shop) ? shop : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  // Sentry quota protection, unauthenticated caller: a global ceiling (the real defence, it cannot
  // be dodged by rotating identities), a per-shop budget so one broken merchant session cannot
  // drown the others, and the IP as a last-resort per-client limit (this route is called directly
  // from the admin iframe, not through the app proxy, so the address is the real client's).
  const shop = shopFromRequest(request);
  const limits = await Promise.all([
    checkRateLimit("report-error:global", { limit: GLOBAL_LIMIT_PER_MINUTE, windowMs: 60_000, fixedWindow: true }),
    shop
      ? checkRateLimit(`report-error:shop:${shop}`, { limit: SHOP_LIMIT_PER_MINUTE, windowMs: 60_000 })
      : Promise.resolve({ ok: true as const }),
    checkRateLimit(`report-error:${getClientIp(request)}`, { limit: 10, windowMs: 60_000 }),
  ]);
  const blocked = limits.find((limit) => !limit.ok);
  if (blocked && !blocked.ok) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many error reports.",
      retryable: true,
      retryAfterSeconds: blocked.retryAfterSeconds,
    });
  }

  try {
    const parsed = ReportErrorRequestSchema.safeParse(
      await readJsonBody<unknown>(request, {
        maxBytes: MAX_REPORT_BYTES,
        tooLargeMessage: "Error report is too large.",
        invalidMessage: "Error report must be valid JSON.",
      }),
    );
    if (!parsed.success) {
      return apiError(request, {
        status: 400,
        code: "INVALID_ERROR_REPORT",
        message: parsed.error.issues[0]?.message ?? "Invalid error report.",
      });
    }
    const body = parsed.data;

    const err = new Error(body.message.slice(0, 1000));
    if (body.stack) err.stack = body.stack.slice(0, 5000);

    Sentry.captureException(err, {
      tags: { source: "client_error_boundary" },
      extra: { url: body.url ? safeUrl(body.url) : undefined },
    });
    waitUntil(Sentry.flush(2000));
  } catch (error) {
    return handleApiError(request, error, "api.report-error");
  }
  return apiJson(request, { ok: true }, { status: 202 });
};

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return undefined;
  }
}
