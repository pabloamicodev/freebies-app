import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { ProductSearchQuerySchema } from "@promo/shared-types";
import { searchProductCache } from "../lib/catalog-search.server.js";
import { apiError, apiJson, handleApiError, parseQuery } from "../lib/api-response.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const { q, ids, limit, variants: includeVariants } = parseQuery(
      request,
      ProductSearchQuerySchema,
      ["q", "ids", "limit", "variants"],
      (message) =>
        message.includes("too long")
          ? "QUERY_TOO_LONG"
          : message.includes("mixed")
            ? "MIXED_PRODUCT_ID_TYPES"
            : "INVALID_PRODUCT_IDS",
    );

    const db = getDb();
    const shopRows = await db
      .select({ id: shops.id })
      .from(shops)
      .where(eq(shops.myshopifyDomain, session.shop))
      .limit(1);

    const shopId = shopRows[0]?.id;
    if (!shopId) {
      return apiError(request, {
        status: 404,
        code: "SHOP_NOT_FOUND",
        message: "Shop not found. Reinstall the app and retry.",
      });
    }

    return apiJson(request, await searchProductCache(db, shopId, { q, ids, limit, includeVariants }), { status: 200 });
  } catch (err) {
    return handleApiError(request, err, "api.products.search");
  }
};
