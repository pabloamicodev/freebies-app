/**
 * /app/offers/new/bundle — redirect to classic-bundle template.
 * The real wizard lives at app.offers.new.bundle.$template.tsx
 */
import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app/offers/new/bundle/classic-bundle");
};
