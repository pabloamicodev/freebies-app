import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb, analyticsEvents, offers, widgets } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { checkRateLimit, getClientIp } from "../lib/rate-limit.server.js";
import { apiError, apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

const MAX_ANALYTICS_BODY_BYTES = 64 * 1024;
const PUBLIC_ANALYTICS_EVENTS = new Set([
  "page_viewed",
  "product_viewed",
  "cart_viewed",
  "checkout_started",
  "order_placed",
]);
const PROMO_ANALYTICS_EVENT = /^promo_engine:[a-z0-9][a-z0-9_:-]{0,79}$/;

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export function loader({ request }: LoaderFunctionArgs) {
  return apiError(request, {
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed.",
    headers: { Allow: "POST" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  try {
    const { id: shopId, loggedInCustomerId } = await getSignedShop(request);
    const rateLimit = await checkRateLimit(`analytics:${shopId}:${getClientIp(request)}`, { limit: 300, windowMs: 60_000 });
    if (!rateLimit.ok) {
      return apiError(request, {
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many analytics events.",
        retryable: true,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: MAX_ANALYTICS_BODY_BYTES,
      tooLargeMessage: "Analytics payload is too large (max 64 KB).",
      invalidMessage: "Analytics payload must be valid JSON.",
    });

    // The web pixel sends a batch ({ events: [...] }); the storefront runtime
    // sends a single event object directly — normalize to a list either way.
    const rawEvents = Array.isArray(body["events"])
      ? (body["events"] as unknown[])
      : [body];
    if (rawEvents.length === 0) {
      return apiError(request, { status: 400, code: "EMPTY_EVENT_BATCH", message: "No events provided." });
    }
    if (rawEvents.length > 20) {
      return apiError(request, {
        status: 400,
        code: "EVENT_BATCH_TOO_LARGE",
        message: "Too many events in one batch (max 20).",
      });
    }
    if (rawEvents.some((event) => typeof event !== "object" || event === null || Array.isArray(event))) {
      return apiError(request, { status: 400, code: "INVALID_EVENT", message: "Every event must be a JSON object." });
    }
    const events = rawEvents as Record<string, unknown>[];
    const eventNames = events.map(readEventName);
    const invalidEventIndexes = eventNames.flatMap((name, index) => isPublicEventName(name) ? [] : [index]);
    if (invalidEventIndexes.length > 0) {
      return apiError(request, {
        status: 400,
        code: "INVALID_EVENT_NAME",
        message: "One or more analytics event names are not accepted.",
        details: { invalidEventIndexes },
      });
    }

    const trustedCustomerId = loggedInCustomerId && /^\d+$/.test(loggedInCustomerId)
      ? `gid://shopify/Customer/${loggedInCustomerId}`
      : null;

    const db = getDb();

    const offerIds = [...new Set(events.flatMap((event) => {
      const id = uuidOrNull(event["offer_id"] ?? event["offerId"]);
      return id ? [id] : [];
    }))];
    const widgetIds = [...new Set(events.flatMap((event) => {
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

    const rowsToInsert = events.map((event, index) => {
      const eventName = eventNames[index]!;
      const rawOfferId = uuidOrNull(event["offer_id"] ?? event["offerId"]);
      const rawWidgetId = uuidOrNull(event["widget_id"] ?? event["widgetId"]);
      const { customer_id: _customerId, customerId: _customerIdCamel, ...safeProperties } = event;

      return {
        shopId,
        eventName,
        sessionId: boundedString(event["session_id"] ?? event["sessionId"], 200),
        cartToken: boundedString(event["cart_token"] ?? event["cartToken"], 256),
        customerId: trustedCustomerId,
        offerId: rawOfferId && validOfferIds.has(rawOfferId) ? rawOfferId : null,
        widgetId: rawWidgetId && validWidgetIds.has(rawWidgetId) ? rawWidgetId : null,
        properties: safeProperties,
      };
    });

    await db.insert(analyticsEvents).values(rowsToInsert);
    return apiJson(request, { ok: true, accepted: rowsToInsert.length }, { status: 202 });
  } catch (err) {
    return handleApiError(request, err, "apps.promo-engine.analytics");
  }
}

function readEventName(event: Record<string, unknown>): string | null {
  const value = event["event"] ?? event["event_name"] ?? event["eventName"];
  return typeof value === "string" ? value : null;
}

function isPublicEventName(value: string | null): value is string {
  return value !== null && (PUBLIC_ANALYTICS_EVENTS.has(value) || PROMO_ANALYTICS_EVENT.test(value));
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : null;
}
