/**
 * POST /api/products/sync
 *
 * Triggers a full product catalog sync from Shopify Admin API → local productCache.
 * Called automatically by the product picker when cache is empty, and by afterAuth
 * on new shop installs.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../lib/token-crypto.server.js";
import { syncAllProducts } from "../lib/sync/product-sync.server.js";
import * as Sentry from "@sentry/node";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const db = getDb();

  const shopRows = await db
    .select({
      id: shops.id,
      currencyCode: shops.currencyCode,
      accessTokenEncrypted: shops.accessTokenEncrypted,
    })
    .from(shops)
    .where(eq(shops.myshopifyDomain, session.shop))
    .limit(1);

  const shop = shopRows[0];
  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const accessToken = await decryptToken(shop.accessTokenEncrypted);

  try {
    const result = await syncAllProducts(
      shop.id,
      session.shop,
      accessToken,
      shop.currencyCode ?? "USD",
    );
    return Response.json({ ok: true, synced: result.synced });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, { tags: { route: "api.products.sync" } });
    console.error("[api.products.sync] Sync failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
