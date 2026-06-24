/**
 * Manual sync trigger endpoints.
 * POST /api/sync/products — trigger full product catalog sync
 * POST /api/sync/markets  — trigger market sync
 * POST /api/sync/inventory — trigger inventory re-sync
 */

import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import * as Sentry from "@sentry/node";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../lib/token-crypto.server.js";
import { syncMarketsForShop } from "../lib/sync/market-sync.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const syncType = url.pathname.split("/").pop(); // "products", "markets", "inventory"

  const db = getDb();
  const [shop] = await db.select().from(shops)
    .where(eq(shops.myshopifyDomain, session.shop)).limit(1);

  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const accessToken = await decryptToken(shop.accessTokenEncrypted);

  switch (syncType) {
    case "markets": {
      waitUntil(
        syncMarketsForShop(shop.id, shop.myshopifyDomain, accessToken)
          .catch((err) => {
            Sentry.captureException(err, { tags: { sync: "markets", shop: shop.myshopifyDomain } });
            console.error("manual market-sync failed", err instanceof Error ? err.message : err);
          }),
      );
      return Response.json({ queued: true, type: "markets" });
    }

    case "products":
    case "inventory":
      return Response.json({ error: "Full re-sync runs via Vercel Cron — trigger manually from Vercel dashboard" }, { status: 400 });

    default:
      return Response.json({ error: "Unknown sync type" }, { status: 400 });
  }
};
