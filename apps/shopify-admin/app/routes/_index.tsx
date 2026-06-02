import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { login } from "../shopify.server.js";

/**
 * Root route — redirects to /app (the main authenticated dashboard).
 * Shopify Admin opens the app at the application_url (root "/"),
 * so this redirect ensures the embedded app loads correctly.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  // If Shopify passed ?shop= (install flow), initiate OAuth
  if (shop) {
    return login(request);
  }

  // Otherwise redirect to main dashboard
  return redirect("/app");
};
