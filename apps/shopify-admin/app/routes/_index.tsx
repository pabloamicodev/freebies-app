import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Root route — redirects to /app preserving ALL Shopify query params.
 * Shopify Admin opens at application_url (root "/") with embedded params:
 *   ?embedded=1&shop=...&hmac=...&session=...&timestamp=...
 * authenticate.admin() in app.tsx NEEDS these params for token exchange.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Build /app URL with all original query params preserved
  const appUrl = new URL("/app", url.origin);
  url.searchParams.forEach((value, key) => appUrl.searchParams.set(key, value));
  return redirect(appUrl.toString());
};
