import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb, analyticsEvents, offers, widgets } from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import { AnalyticsRequestSchema, analyticsEventName, normalizeAnalyticsRequest } from "@promo/shared-types";
import { getSignedShopCached } from "../lib/proxy-shop.server.js";
import { checkRateLimit, envLimit, jitteredRetryAfter } from "../lib/rate-limit.server.js";
import { sanitizeAnalyticsProperties } from "../lib/analytics-properties.server.js";
import { apiError, apiJson, handleApiError, readJsonBody } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

const MAX_ANALYTICS_BODY_BYTES = 64 * 1024;
const ANALYTICS_SESSION_LIMIT_PER_MINUTE = 120;
/** One request may span a few sessions (the pixel batches), but never an unbounded number of rate-limit lookups. */
const MAX_SESSIONS_PER_REQUEST = 10;
/** Events without a session id share one bucket, so omitting the id is not a way around the session limit. */
const NO_SESSION_KEY = "none";
const NO_SESSION_LIMIT_PER_MINUTE = 600;

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
    const { id: shopId, loggedInCustomerId } = await getSignedShopCached(request);
    // Never keyed by IP (it is Shopify's behind the app proxy): shop-wide ceiling first,
    // per-session budget once the body is parsed.
    const rateLimit = await checkRateLimit(`analytics:${shopId}`, {
      limit: envLimit("ANALYTICS_SHOP_LIMIT_PER_MINUTE", 12_000),
      windowMs: 60_000,
      fixedWindow: true,
      onRedisUnavailable: "skip",
    });
    if (!rateLimit.ok) {
      return apiError(request, {
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many analytics events.",
        retryable: true,
        retryAfterSeconds: jitteredRetryAfter(rateLimit.retryAfterSeconds),
      });
    }

    const parsed = AnalyticsRequestSchema.safeParse(
      await readJsonBody<unknown>(request, {
        maxBytes: MAX_ANALYTICS_BODY_BYTES,
        tooLargeMessage: "Analytics payload is too large (max 64 KB).",
        invalidMessage: "Analytics payload must be valid JSON.",
      }),
    );
    if (!parsed.success) {
      return apiError(request, {
        status: 400,
        code: "INVALID_ANALYTICS_PAYLOAD",
        message: parsed.error.issues[0]?.message ?? "Invalid analytics payload.",
      });
    }
    // The web pixel sends a batch ({ events: [...] }); the storefront runtime sends a single event object.
    const events = normalizeAnalyticsRequest(parsed.data);
    const eventNames = events.map((event) => analyticsEventName(event)!);

    // Every event's session id counts, not just the first: a batch can mix sessions.
    const sessionKeys = [...new Set(events.map((event) => boundedString(event["session_id"] ?? event["sessionId"], 200) ?? NO_SESSION_KEY))];
    if (sessionKeys.length > MAX_SESSIONS_PER_REQUEST) {
      return apiError(request, {
        status: 400,
        code: "INVALID_ANALYTICS_PAYLOAD",
        message: "Too many distinct sessions in one analytics request.",
      });
    }
    const sessionLimits = await Promise.all(
      sessionKeys.map((key) =>
        checkRateLimit(`analytics:${shopId}:s:${key}`, {
          limit: key === NO_SESSION_KEY ? NO_SESSION_LIMIT_PER_MINUTE : ANALYTICS_SESSION_LIMIT_PER_MINUTE,
          windowMs: 60_000,
        }),
      ),
    );
    const sessionLimit = sessionLimits.find((result) => !result.ok);
    if (sessionLimit && !sessionLimit.ok) {
      return apiError(request, {
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many analytics events.",
        retryable: true,
        retryAfterSeconds: jitteredRetryAfter(sessionLimit.retryAfterSeconds),
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

      return {
        shopId,
        eventName,
        sessionId: boundedString(event["session_id"] ?? event["sessionId"], 200),
        cartToken: boundedString(event["cart_token"] ?? event["cartToken"], 256),
        customerId: trustedCustomerId,
        offerId: rawOfferId && validOfferIds.has(rawOfferId) ? rawOfferId : null,
        widgetId: rawWidgetId && validWidgetIds.has(rawWidgetId) ? rawWidgetId : null,
        properties: sanitizeAnalyticsProperties(event),
      };
    });

    await db.insert(analyticsEvents).values(rowsToInsert);
    return apiJson(request, { ok: true, accepted: rowsToInsert.length }, { status: 202 });
  } catch (err) {
    return handleApiError(request, err, "apps.promo-engine.analytics");
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : null;
}
