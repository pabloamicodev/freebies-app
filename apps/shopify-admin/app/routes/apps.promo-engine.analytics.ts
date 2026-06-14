import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { analyticsEvents } from "@promo/db";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const { id: shopId, db } = await getSignedShop(request);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const eventName = typeof body["event"] === "string"
    ? body["event"]
    : typeof body["eventName"] === "string"
      ? body["eventName"]
      : "unknown";

  await db.insert(analyticsEvents).values({
    shopId,
    eventName,
    sessionId: typeof body["session_id"] === "string" ? body["session_id"] : typeof body["sessionId"] === "string" ? body["sessionId"] : null,
    cartToken: typeof body["cart_token"] === "string" ? body["cart_token"] : typeof body["cartToken"] === "string" ? body["cartToken"] : null,
    customerId: typeof body["customer_id"] === "string" ? body["customer_id"] : null,
    offerId: uuidOrNull(body["offer_id"] ?? body["offerId"]),
    widgetId: uuidOrNull(body["widget_id"] ?? body["widgetId"]),
    properties: body,
  });

  return Response.json({ ok: true });
}
