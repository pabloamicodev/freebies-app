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
import { apiError, apiJson, handleApiError } from "../lib/api-response.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(request, { status: 405, code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", headers: { Allow: "POST" } });
  }
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const syncType = url.pathname.split("/").pop(); // "products", "markets", "inventory"

    const db = getDb();
    const [shop] = await db.select().from(shops)
      .where(eq(shops.myshopifyDomain, session.shop)).limit(1);

    if (!shop) {
      return apiError(request, {
        status: 404,
        code: "SHOP_NOT_FOUND",
        message: "Shop not found. Reinstall the app and retry.",
      });
    }

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
        return apiJson(request, { ok: true, queued: true, type: "markets" }, { status: 202 });
      }

      case "products":
      case "inventory":
        return apiError(request, {
          status: 409,
          code: "SYNC_REQUIRES_BACKGROUND_JOB",
          message: "A full re-sync must run as a background job from the Vercel dashboard.",
        });

      default:
        return apiError(request, {
          status: 400,
          code: "UNKNOWN_SYNC_TYPE",
          message: "Unknown sync type.",
          details: { allowed: ["markets", "products", "inventory"] },
        });
    }
  } catch (err) {
    return handleApiError(request, err, "api.sync");
  }
};
