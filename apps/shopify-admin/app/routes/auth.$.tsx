/**
 * Catch-all: /auth/callback and other /auth/* sub-paths.
 * /auth/login → handled by auth.login.tsx (calls shopify.login)
 * /auth        → handled by auth.tsx       (calls shopify.login)
 * /auth/*      → this file                 (calls authenticate.admin for OAuth callback)
 */
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
