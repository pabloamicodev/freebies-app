import type { ActionFunctionArgs } from "react-router";
import * as Sentry from "@sentry/node";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Rate-limit by IP to prevent Sentry quota exhaustion from unauthenticated callers.
  const rateLimit = await checkRateLimit(`report-error:${getClientIp(request)}`, { limit: 10, windowMs: 60_000 });
  if (!rateLimit.ok) return Response.json({ ok: false }, { status: 429 });

  try {
    const body = await request.json().catch(() => null) as { message?: string; stack?: string; url?: string } | null;
    if (!body?.message || typeof body.message !== "string") return Response.json({ ok: false });

    const err = new Error(body.message.slice(0, 1000));
    if (body.stack && typeof body.stack === "string") err.stack = body.stack.slice(0, 5000);

    Sentry.captureException(err, {
      tags: { source: "client_error_boundary" },
      extra: { url: typeof body.url === "string" ? body.url.slice(0, 500) : undefined },
    });
  } catch {
    // never fail the client
  }
  return Response.json({ ok: true });
};
