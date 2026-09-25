import type { LoaderFunctionArgs } from "react-router";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { getOrderAttributions } from "../lib/order-attribution.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await getSignedShop(request);
    const orderGid = new URL(request.url).searchParams.get("order_gid");
    const attributions = await getOrderAttributions(shop.db, shop, orderGid, shop.loggedInCustomerId);
    return apiJson(request, { attributions });
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.customer.order-attribution");
  }
}
