/**
 * Route: /auth/login
 * Shopify SDK requires this specific route to call shopify.login()
 * instead of shopify.authenticate.admin().
 */
import { login } from "../shopify.server.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return login(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return login(request);
};
