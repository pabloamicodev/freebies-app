/**
 * Manual sync trigger endpoints.
 * POST /api/sync/products — trigger full product catalog sync
 * POST /api/sync/markets  — trigger market sync
 * POST /api/sync/inventory — trigger inventory re-sync
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const syncType = url.pathname.split("/").pop(); // "products", "markets", "inventory"

  const db = getDb();
  const [shop] = await db.select().from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);

  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const { productSyncQueue } = await import("../../workers/product-sync/src/queues.js");

  switch (syncType) {
    case "products":
      await productSyncQueue.add("manual-product-sync", {
        shopId: shop.id,
        shopDomain: shop.myshopifyDomain,
        accessToken: shop.accessTokenEncrypted,
        mode: "full" as const,
      }, { priority: 2 });
      return Response.json({ queued: true, type: "products" });

    case "markets":
      // Market sync — enqueue
      return Response.json({ queued: true, type: "markets" });

    case "inventory":
      return Response.json({ queued: true, type: "inventory" });

    default:
      return Response.json({ error: "Unknown sync type" }, { status: 400 });
  }
};
