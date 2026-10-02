/**
 * The analytics endpoint is reachable by anyone who can hit the storefront app proxy, and its
 * rows feed dashboards, so stored properties are an allowlist of scalar fields with bounded
 * length. Anything else (emails, click ids, nested blobs, forged order totals) is dropped.
 */
const STRING_PROPERTIES: Record<string, number> = {
  product_id: 100,
  product_title: 200,
  order_id: 100,
  variant_id: 100,
  reason: 100,
  action_type: 60,
  widget_type: 60,
  error: 300,
  key: 100,
  line_key: 100,
  offer_version: 100,
  total_value: 40,
};
const NUMBER_PROPERTIES = new Set(["quantity"]);
const UTM_KEEP = /^utm_[a-z0-9_]{1,30}$/i;

/** Path plus utm_* only: no scheme/host, no hash, no other query params (emails, gclid, tokens). */
export function sanitizeAnalyticsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  try {
    const url = new URL(raw, "https://localhost");
    const kept: string[] = [];
    url.searchParams.forEach((value, key) => {
      if (UTM_KEEP.test(key)) kept.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.slice(0, 100))}`);
    });
    return `${url.pathname}${kept.length ? `?${kept.join("&")}` : ""}`.slice(0, 300);
  } catch {
    return null;
  }
}

function readScalar(name: string, value: unknown): string | number | null {
  if (name === "url") return sanitizeAnalyticsUrl(value);
  const max = STRING_PROPERTIES[name];
  if (max !== undefined) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
  }
  if (NUMBER_PROPERTIES.has(name)) {
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
  }
  return null;
}

/** Merges the event's top level and its nested `properties` object (the pixel nests them), nested winning. */
export function sanitizeAnalyticsProperties(event: Record<string, unknown>): Record<string, string | number> {
  const nested = event["properties"];
  const sources = [event, typeof nested === "object" && nested !== null && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {}];
  const names = ["url", ...Object.keys(STRING_PROPERTIES), ...NUMBER_PROPERTIES];
  const result: Record<string, string | number> = {};
  for (const name of names) {
    for (const source of sources) {
      const value = readScalar(name, source[name]);
      if (value !== null) result[name] = value;
    }
  }
  return result;
}
