/**
 * GET /app/api/theme-catalog — published-theme templates and sections for the wizards' picker.
 * Response: ThemeCatalog ({ themeId, themeName, templates, sections } or { unavailable: true }).
 */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { getThemeCatalog } from "../lib/theme-catalog.server.js";
import { apiJson, handleApiError } from "../lib/api-response.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session, shopDomain } = await getShopContext(request);
    const catalog = await getThemeCatalog({ shopDomain, accessToken: session.accessToken ?? "" });
    return apiJson(request, catalog, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(request, err, "app.api.theme-catalog");
  }
};
