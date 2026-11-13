/**
 * CSV export endpoint for a single offer or all offers.
 * GET /api/offers/:id/export → single offer CSV
 * GET /api/offers/export → all offers CSV (every status, not just active)
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { exportOffersCsv } from "../lib/offer-csv-export.server.js";
import { apiError, getRequestId, handleApiError } from "../lib/api-response.server.js";
import { parseUuidParam } from "../lib/route-params.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  // /api/offers/export has no :id (all offers); /api/offers/:id/export must carry a UUID.
  const offerId = params["id"] === undefined ? undefined : parseUuidParam(params);

  const shopRows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  if (!shopRows[0]) {
    return apiError(request, {
      status: 404,
      code: "SHOP_NOT_FOUND",
      message: "Shop not found. Reinstall the app and retry.",
    });
  }
  const shopId = shopRows[0].id;
  const shopCurrency = shopRows[0].currencyCode ?? "USD";

  const { csv, matchedOffers } = await exportOffersCsv(db, { shopId, shopCurrency }, { offerIds: offerId ? [offerId] : undefined });

  if (offerId && matchedOffers === 0) {
    return apiError(request, { status: 404, code: "OFFER_NOT_FOUND", message: "Offer not found." });
  }

  const filename = offerId ? `offer-${offerId.slice(0, 8)}.csv` : `all-offers-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": getRequestId(request),
    },
  });
  } catch (err) {
    return handleApiError(request, err, "api.offers.export");
  }
};
