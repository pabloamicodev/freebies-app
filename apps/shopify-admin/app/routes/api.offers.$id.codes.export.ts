/** GET /api/offers/:id/codes/export?q=&status= → CSV of the offer's discount codes. */

import type { LoaderFunctionArgs } from "react-router";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { exportDiscountCodes } from "../lib/discount-codes.server.js";
import { discountCodesToCsv } from "../lib/discount-code-generation.js";
import { getRequestId, handleApiError } from "../lib/api-response.server.js";

const STATUSES = ["active", "disabled", "exhausted"] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const { shopId, db } = await getShopContext(request);
    const offerId = params["id"]!;
    const offer = await loadOwnedOffer(db, shopId, offerId);
    const url = new URL(request.url);
    const rows = await exportDiscountCodes(db, shopId, offerId, {
      search: url.searchParams.get("q") ?? "",
      status: STATUSES.find((status) => status === url.searchParams.get("status")),
    });
    return new Response(discountCodesToCsv(rows), {
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
