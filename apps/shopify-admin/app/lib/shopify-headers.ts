/**
 * Required headers export for every route that calls authenticate.admin().
 * Without this, React Router v7 single-fetch drops the Shopify auth headers
 * needed for App Bridge, causing an infinite redirect loop.
 *
 * Usage in every /app/* route:
 *   export { shopifyHeaders as headers } from "~/lib/shopify-headers";
 */
import type { HeadersFunction } from "react-router";

export const shopifyHeaders: HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  // Merge both: action headers take priority (cover POST/redirect flows)
  const merged = new Headers(loaderHeaders);
  for (const [key, value] of actionHeaders.entries()) {
    merged.set(key, value);
  }
  return merged;
};
