import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { customerIdFromSub, getActiveShop, shopDomainFromDest } from "../lib/extension-auth.server.js";
import { getOrderAttributions } from "../lib/order-attribution.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

// Customer account UI extensions can't use the App Proxy (no CORS preflight,
// no logged_in_customer_id), so they call the app directly with a session token.
export async function loader({ request }: LoaderFunctionArgs) {
  // Also answers the OPTIONS preflight (thrown 204 with CORS headers).
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);
  try {
    const shop = await getActiveShop(shopDomainFromDest(sessionToken.dest));
    const orderGid = new URL(request.url).searchParams.get("order_gid");
    const attributions = await getOrderAttributions(shop.db, shop, orderGid, customerIdFromSub(sessionToken.sub));
    return cors(apiJson(request, { attributions }));
  } catch (error) {
    return cors(handleApiError(request, error, "api.customer-account.order-attribution"));
  }
}
