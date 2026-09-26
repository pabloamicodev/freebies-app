import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { customerIdFromSub, getActiveShop, shopDomainFromDest } from "../lib/extension-auth.server.js";
import { handleEvaluationRequest } from "../lib/promo-evaluation.server.js";
import { apiError, handleApiError } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

// Checkout UI extensions can't use the App Proxy (no CORS preflight, no
// logged_in_customer_id), so they call the app directly with a session token.
export async function loader({ request }: LoaderFunctionArgs) {
  // Answers the OPTIONS preflight (thrown 204 with CORS headers).
  const { cors } = await authenticate.public.checkout(request);
  return cors(apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } }));
}

export async function action({ request }: ActionFunctionArgs) {
  const { cors, sessionToken } = await authenticate.public.checkout(request);
  if (request.method !== "POST") {
    return cors(apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } }));
  }
  try {
    const shop = await getActiveShop(shopDomainFromDest(sessionToken.dest));
    return cors(await handleEvaluationRequest(request, shop, customerIdFromSub(sessionToken.sub)));
  } catch (error) {
    return cors(handleApiError(request, error, "api.checkout.evaluate"));
  }
}
