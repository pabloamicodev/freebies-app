import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { createPhaseTimer, handleEvaluationRequest } from "../lib/promo-evaluation.server.js";
import { apiError, handleApiError } from "../lib/api-response.server.js";

// Storefront endpoints get their own Vercel function (a distinct route config
// splits the server bundle) so a cold start doesn't load the whole admin app.
export const config = { maxDuration: 15 };

export function loader({ request }: LoaderFunctionArgs) {
  return apiError(request, {
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed.",
    headers: { Allow: "POST" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  try {
    const timer = createPhaseTimer();
    const signedShop = await getSignedShop(request);
    timer.mark("auth");
    return await handleEvaluationRequest(request, signedShop, signedShop.loggedInCustomerId, timer);
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.evaluate");
  }
}
