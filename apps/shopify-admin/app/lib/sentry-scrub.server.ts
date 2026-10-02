import type { ErrorEvent } from "@sentry/node";

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-shopify-access-token", "x-shopify-hmac-sha256", "x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "x-vercel-cron-secret"]);
const SENSITIVE_QUERY = /(^|&)(signature|hmac|session|id_token|logged_in_customer_id|code|email|token)=[^&]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_TOKEN = /\b(shp(?:at|ca|ss|pa)_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g;

function scrubString(value: string): string {
  return value.replace(EMAIL, "[email]").replace(SECRET_TOKEN, "[secret]");
}

function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, depth + 1)]));
}

/**
 * Sentry `beforeSend` scrubber, used together with `sendDefaultPii: false`. Removes cookies, auth headers,
 * client IPs, signed-proxy query params and anything that looks like an email or Shopify token from the
 * request, user, extra, breadcrumbs and exception messages.
 */
export function scrubSentryEvent<T extends ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(
        Object.entries(event.request.headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
      );
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = event.request.query_string.replace(SENSITIVE_QUERY, "$1$2=[redacted]");
    }
    if (typeof event.request.url === "string") {
      event.request.url = event.request.url.replace(/\?.*$/, (query) => query.slice(1).replace(SENSITIVE_QUERY, "$1$2=[redacted]").replace(/^/, "?"));
    }
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (event.extra) event.extra = scrubDeep(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubDeep(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) event.breadcrumbs = scrubDeep(event.breadcrumbs) as typeof event.breadcrumbs;
  if (event.message) event.message = scrubString(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
  }
  return event;
}
