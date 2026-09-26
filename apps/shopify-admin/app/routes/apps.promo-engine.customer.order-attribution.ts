import type { LoaderFunctionArgs } from "react-router";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { proxyRateLimitResponse } from "../lib/proxy-rate-limit.server.js";
import { getOrderAttributions } from "../lib/order-attribution.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await getSignedShop(request);
    const limited = await proxyRateLimitResponse(request, "order-attribution", shop.id, 60);
    if (limited) return limited;
    const orderGid = new URL(request.url).searchParams.get("order_gid");
    const attributions = await getOrderAttributions(shop.db, shop, orderGid, shop.loggedInCustomerId);
    return apiJson(request, { attributions });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.customer.order-attribution");
  }
}
