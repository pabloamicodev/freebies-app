/**
 * Markets API endpoint — returns the shop's Shopify Markets for widget config UI.
 * GET /api/markets
 * Returns cached data (1h TTL) or fetches live from Shopify Admin API.
 */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { getMarketsForShop } from "../lib/markets.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { shopId } = await getShopContext(request);

    if (!shopId) {
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    const markets = await getMarketsForShop(shopId);

    return Response.json({ markets }, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api.markets]", message);
    return Response.json({ error: message }, { status: 500 });
  }
};
