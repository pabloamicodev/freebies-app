import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb, analyticsEvents, offers, widgets } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Method not allowed", { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  const { id: shopId } = await getSignedShop(request);
  const rateLimit = await checkRateLimit(`analytics:${shopId}:${getClientIp(request)}`, { limit: 300, windowMs: 60_000 });
  if (!rateLimit.ok) {
    return Response.json(
      { error: "Too many analytics events" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventName = typeof body["event"] === "string"
    ? body["event"]
    : typeof body["eventName"] === "string"
      ? body["eventName"]
      : null;

  if (!eventName) {
    return Response.json({ error: "Missing required field: event or eventName" }, { status: 400 });
  }

  if (eventName.length > 100) {
    return Response.json({ error: "event name too long (max 100 chars)" }, { status: 400 });
  }

  const propertiesJson = JSON.stringify(body);
  if (propertiesJson.length > 65_536) {
    return Response.json({ error: "payload too large (max 64 KB)" }, { status: 413 });
  }

  try {
    const db = getDb();

    const rawOfferId = uuidOrNull(body["offer_id"] ?? body["offerId"]);
    const rawWidgetId = uuidOrNull(body["widget_id"] ?? body["widgetId"]);

    // Verify that referenced offer/widget actually belong to the authenticated shop.
    const [offerCheck, widgetCheck] = await Promise.all([
      rawOfferId
        ? db.select({ id: offers.id }).from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, rawOfferId))).limit(1)
        : Promise.resolve([]),
      rawWidgetId
        ? db.select({ id: widgets.id }).from(widgets).where(and(eq(widgets.shopId, shopId), eq(widgets.id, rawWidgetId))).limit(1)
        : Promise.resolve([]),
    ]);

    await db.insert(analyticsEvents).values({
      shopId,
      eventName,
      sessionId: typeof body["session_id"] === "string" ? body["session_id"] : typeof body["sessionId"] === "string" ? body["sessionId"] : null,
      cartToken: typeof body["cart_token"] === "string" ? body["cart_token"] : typeof body["cartToken"] === "string" ? body["cartToken"] : null,
      customerId: typeof body["customer_id"] === "string" ? body["customer_id"] : null,
      offerId: offerCheck[0]?.id ?? null,
      widgetId: widgetCheck[0]?.id ?? null,
      properties: body,
    });
  } catch (err) {
    console.error("[analytics] Failed to insert event", { shopId, eventName, err });
    return Response.json({ error: "Failed to record event" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
