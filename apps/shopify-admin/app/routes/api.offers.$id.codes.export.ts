/** GET /api/offers/:id/codes/export?q=&status= → CSV of the offer's discount codes. */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { streamDiscountCodesCsv } from "../lib/discount-codes.server.js";
import { CodesExportQuerySchema } from "@promo/shared-types";
import { getRequestId, handleApiError, parseQuery } from "../lib/api-response.server.js";
import { parseUuidParam } from "../lib/route-params.js";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { shopId, db } = await getShopContext(request);
    const offerId = parseUuidParam(params);
    const offer = await loadOwnedOffer(db, shopId, offerId);
    const { q, status } = parseQuery(request, CodesExportQuerySchema, ["q", "status"]);
    return new Response(streamDiscountCodesCsv(db, shopId, offerId, { search: q, status }), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="codes-${offer.id.slice(0, 8)}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": getRequestId(request),
      },
    });
  } catch (err) {
    if (err instanceof Response) throw err;
    return handleApiError(request, err, "api.offers.codes.export");
  }
};
