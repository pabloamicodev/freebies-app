import { PROMO_LANDING_URL_KEY, PROMO_PAGE_URL_KEY } from "@promo/shared-types/page-stamps";
import { browserLandingUrl, browserPageUrl } from "./metadata-bridge.js";
import { browserStampContext } from "./stamp-context.js";

/**
 * The stamp a line added right now would carry: page URL, visit landing, template, sections, experiment.
 * `withPromoMetadata` resolves the same three sources, so what is written on a line and what the server
 * judges a prospective add with (`prospective` on /evaluate, `ctx` on the proxy GETs) cannot drift.
 */
export function currentStampContext(): Record<string, string> {
  const page = browserPageUrl();
  const landing = browserLandingUrl();
  return {
    ...(page ? { [PROMO_PAGE_URL_KEY]: page } : {}),
    ...(landing ? { [PROMO_LANDING_URL_KEY]: landing } : {}),
    ...browserStampContext(),
  };
}

/** Stable identity of a context: a change means widgets and the cart verdict must be judged again. */
export function contextKey(context: Record<string, string> = currentStampContext()): string {
  return Object.keys(context)
    .sort()
    .map((key) => `${key}=${context[key]}`)
    .join("&");
}

/** base64url JSON, the `ctx` query param of /bundle and /product-customizations. Keys sorted: proxy responses are cached by URL. */
export function encodeContext(context: Record<string, string> = currentStampContext()): string {
  const sorted = Object.fromEntries(Object.keys(context).sort().map((key) => [key, context[key]]));
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * May a widget show its promise? "cart": the Function's view of the current lines (qualified offer).
 * "add": the promise is for adding something now, so the stamp that add would write must pass the offer's
 * page conditions. `pageGate` only lists offers with page conditions; an older server omits it (no veto).
 */
export function canPromise(
  result: { qualifiedOffers?: Array<{ offerId: string }>; pageGate?: Record<string, boolean> } | null | undefined,
  offerId: string,
  scope: "cart" | "add",
): boolean {
  return scope === "cart"
    ? !!result?.qualifiedOffers?.some((offer) => offer.offerId === offerId)
    : !!result && result.pageGate?.[offerId] !== false;
}
