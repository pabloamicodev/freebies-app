/**
 * /app/offers/new/gift — redirect to scratch template.
 * The real wizard lives at app.offers.new.gift.$template.tsx
 * which handles /app/offers/new/gift/:template
 */
import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return redirect("/app/offers/new/gift/scratch");
};
