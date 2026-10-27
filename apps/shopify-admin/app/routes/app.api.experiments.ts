/**
 * GET /app/api/experiments — the shop's Experiment Engine directory for the test-group picker.
 * Response: { experiments: [...] } or { unavailable: true } (not installed, unreadable or malformed).
 */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { getExperimentDirectory } from "../lib/experiment-directory.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session, shopDomain } = await getShopContext(request);
    const directory = await getExperimentDirectory({ shopDomain, accessToken: session.accessToken ?? "" });
    return apiJson(request, directory, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(request, err, "app.api.experiments");
  }
};
