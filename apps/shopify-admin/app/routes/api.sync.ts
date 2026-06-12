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

  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl || redisUrl.includes("PASSWORD@HOST")) {
    return Response.json({ error: "Redis not configured" }, { status: 503 });
  }

  const { Queue } = await import("bullmq");
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const productSyncQueue = new Queue("product-sync", { connection: redis });

  switch (syncType) {
    case "products": {
      const { decryptToken } = await import("../lib/token-crypto.server.js");
      await productSyncQueue.add("manual-product-sync", {
        shopId: shop.id,
        shopDomain: shop.myshopifyDomain,
        accessToken: await decryptToken(shop.accessTokenEncrypted),
        mode: "full" as const,
      }, { priority: 2 });
      await redis.quit();
      return Response.json({ queued: true, type: "products" });
    }

    case "markets":
      await redis.quit();
      return Response.json({ queued: true, type: "markets" });

    case "inventory":
      await redis.quit();
      return Response.json({ queued: true, type: "inventory" });

    default:
      await redis.quit();
      return Response.json({ error: "Unknown sync type" }, { status: 400 });
  }
};
