/**
 * Required headers export for every route that calls authenticate.admin().
 * Without this, React Router v7 single-fetch drops the Shopify auth headers
 * needed for App Bridge, causing an infinite redirect loop.
 *
 * Usage in every /app/* route:
 *   export { shopifyHeaders as headers } from "~/lib/shopify-headers";
 */
import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Preserve Shopify's auth recovery headers on loader, action, and error
 * responses. In particular, errorHeaders can contain the App Bridge retry
 * signal for an expired embedded-session token and must take precedence over
 * normal loader headers.
 */
export const shopifyHeaders: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
