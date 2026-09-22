import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb, analyticsEvents, offers, widgets } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
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

  // The web pixel sends a batch ({ events: [...] }); the storefront runtime
  // sends a single event object directly — normalize to a list either way.
  const rawEvents = Array.isArray(body["events"]) ? (body["events"] as Record<string, unknown>[]) : [body];
  if (rawEvents.length === 0) {
    return Response.json({ error: "No events provided" }, { status: 400 });
  }
  if (rawEvents.length > 20) {
    return Response.json({ error: "Too many events in one batch (max 20)" }, { status: 400 });
  }

  const propertiesJson = JSON.stringify(body);
  if (propertiesJson.length > 65_536) {
    return Response.json({ error: "payload too large (max 64 KB)" }, { status: 413 });
  }

  try {
    const db = getDb();

    const offerIds = [...new Set(rawEvents.flatMap((event) => {
      const id = uuidOrNull(event["offer_id"] ?? event["offerId"]);
      return id ? [id] : [];
    }))];
    const widgetIds = [...new Set(rawEvents.flatMap((event) => {
      const id = uuidOrNull(event["widget_id"] ?? event["widgetId"]);
      return id ? [id] : [];
    }))];

    const [offerRows, widgetRows] = await Promise.all([
      offerIds.length > 0
        ? db.select({ id: offers.id }).from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, offerIds)))
        : Promise.resolve([]),
      widgetIds.length > 0
        ? db.select({ id: widgets.id }).from(widgets).where(and(eq(widgets.shopId, shopId), inArray(widgets.id, widgetIds)))
        : Promise.resolve([]),
    ]);
    const validOfferIds = new Set(offerRows.map((row) => row.id));
    const validWidgetIds = new Set(widgetRows.map((row) => row.id));

    const rowsToInsert = rawEvents.flatMap((event) => {
      const eventName = typeof event["event"] === "string"
        ? event["event"]
        : typeof event["event_name"] === "string"
          ? event["event_name"]
          : typeof event["eventName"] === "string"
            ? event["eventName"]
            : null;
      if (!eventName || eventName.length > 100) return [];

      const rawOfferId = uuidOrNull(event["offer_id"] ?? event["offerId"]);
      const rawWidgetId = uuidOrNull(event["widget_id"] ?? event["widgetId"]);

      return [{
        shopId,
        eventName,
        sessionId: typeof event["session_id"] === "string" ? event["session_id"] : typeof event["sessionId"] === "string" ? event["sessionId"] : null,
        cartToken: typeof event["cart_token"] === "string" ? event["cart_token"] : typeof event["cartToken"] === "string" ? event["cartToken"] : null,
        customerId: typeof event["customer_id"] === "string" ? event["customer_id"] : null,
        offerId: rawOfferId && validOfferIds.has(rawOfferId) ? rawOfferId : null,
        widgetId: rawWidgetId && validWidgetIds.has(rawWidgetId) ? rawWidgetId : null,
        properties: event,
      }];
    });

    if (rowsToInsert.length > 0) {
      await db.insert(analyticsEvents).values(rowsToInsert);
    }
  } catch (err) {
    console.error("[analytics] Failed to insert event(s)", { shopId, err });
    return Response.json({ error: "Failed to record event" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
