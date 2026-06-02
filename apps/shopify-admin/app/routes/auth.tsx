/**
 * Route: /auth
 * Handles the base /auth path — Shopify redirects here with ?shop= parameter
 * during the OAuth install flow.
 */
import { login } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return login(request);
};
