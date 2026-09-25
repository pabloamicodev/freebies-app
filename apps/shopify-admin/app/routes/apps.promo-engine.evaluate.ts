import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";
import { handleEvaluationRequest } from "../lib/promo-evaluation.server.js";
import { apiError, handleApiError } from "../lib/api-response.server.js";

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
    const signedShop = await getSignedShop(request);
    return await handleEvaluationRequest(request, signedShop, signedShop.loggedInCustomerId);
  } catch (error) {
    return handleApiError(request, error, "apps.promo-engine.evaluate");
  }
}
