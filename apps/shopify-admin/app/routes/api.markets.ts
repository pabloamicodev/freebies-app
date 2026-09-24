/**
 * Markets API endpoint — returns the shop's Shopify Markets for widget config UI.
 * GET /api/markets
 * Returns cached data (1h TTL) or fetches live from Shopify Admin API.
 */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { getMarketsForShop } from "../lib/markets.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { shopId } = await getShopContext(request);

    const markets = await getMarketsForShop(shopId);

    return apiJson(request, { markets }, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    return handleApiError(request, err, "api.markets");
  }
};
