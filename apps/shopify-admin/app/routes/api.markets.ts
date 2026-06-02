/**
 * Markets API endpoint — returns the shop's Shopify Markets for widget config UI.
 * GET /api/markets
 * Returns cached data (1h TTL) or fetches live from Shopify Admin API.
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { getMarketsForShop } from "../lib/markets.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const db = getDb();
  const [shop] = await db.select({ id: shops.id })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  if (!shop) {
    return Response.json({ markets: [] }, { status: 200 });
  }

  const markets = await getMarketsForShop(shop.id);

  return Response.json({ markets }, {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=300", // 5 min browser cache
    },
  });
};
