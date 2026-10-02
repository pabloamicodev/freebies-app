import type { LoaderFunctionArgs } from "react-router";
import { and, eq, gt } from "drizzle-orm";
import { auditLogs, gdprExports } from "@promo/db";
import { getShopContext } from "../lib/shop-context.server.js";
import { parseUuidParam } from "../lib/route-params.js";

/** GET /app/settings/data-requests/:id/download: the stored customers/data_request export as JSON. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const id = parseUuidParam(params);
  const { db, shopId, session } = await getShopContext(request);
  const [row] = await db
    .select()
    .from(gdprExports)
    .where(and(eq(gdprExports.id, id), eq(gdprExports.shopId, shopId), gt(gdprExports.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new Response("Not found", { status: 404 });

  await db.insert(auditLogs).values({
    shopId,
    entityType: "gdpr_customer_data_request",
    entityId: row.customerId,
    action: "download",
    before: null,
    after: { exportId: row.id },
    performedBy: session.shop,
  });

  return new Response(JSON.stringify({ customerId: row.customerId, requestedAt: row.requestedAt, data: row.payload }, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="customer-data-${row.id.slice(0, 8)}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
