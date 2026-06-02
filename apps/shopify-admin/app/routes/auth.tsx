/**
 * Route: /auth
 * Entry point for the Shopify OAuth flow.
 * Calling authenticate.admin() here — NOT login() — because login() redirects
 * back to /auth?shop=... creating an infinite loop. authenticate.admin() at the
 * authPathPrefix detects the shop param and initiates OAuth to Shopify directly.
 */
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
