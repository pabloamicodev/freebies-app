import type { ActionFunctionArgs } from "react-router";
import * as Sentry from "@sentry/node";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = await request.json().catch(() => null) as { message?: string; stack?: string; url?: string } | null;
    if (!body?.message) return Response.json({ ok: false });

    const err = new Error(body.message);
    if (body.stack) err.stack = body.stack;

    Sentry.captureException(err, {
      tags: { source: "client_error_boundary" },
      extra: { url: body.url },
    });
  } catch {
    // never fail the client
  }
  return Response.json({ ok: true });
};
