/**
 * Catch-all: /auth, /auth/callback, /auth/shopify/callback, etc.
 * Single entry point for the entire Shopify OAuth flow.
 * Must use authenticate.admin() — NOT login(). login() redirects back to
 * /auth?shop=... creating an infinite loop.
 * boundary.headers() is required for the embedded app auth frame headers.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
