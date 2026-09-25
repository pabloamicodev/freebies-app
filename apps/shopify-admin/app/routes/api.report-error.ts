import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";
import { apiError, apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";

const MAX_REPORT_BYTES = 16 * 1024;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  // Rate-limit by IP to prevent Sentry quota exhaustion from unauthenticated callers.
  const rateLimit = await checkRateLimit(`report-error:${getClientIp(request)}`, { limit: 10, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return apiError(request, {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many error reports.",
      retryable: true,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  try {
    const body = await readJsonBody<{ message?: unknown; stack?: unknown; url?: unknown }>(request, {
      maxBytes: MAX_REPORT_BYTES,
      tooLargeMessage: "Error report is too large.",
      invalidMessage: "Error report must be valid JSON.",
    });
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return apiError(request, {
        status: 400,
        code: "INVALID_ERROR_REPORT",
        message: "A non-empty error message is required.",
      });
    }

    const err = new Error(body.message.slice(0, 1000));
    if (body.stack && typeof body.stack === "string") err.stack = body.stack.slice(0, 5000);

    Sentry.captureException(err, {
      tags: { source: "client_error_boundary" },
      extra: { url: typeof body.url === "string" ? safeUrl(body.url) : undefined },
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
