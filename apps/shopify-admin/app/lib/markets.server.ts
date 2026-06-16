/**
 * Market data — fetches Shopify Markets from Admin API with an in-memory cache.
 * Used by widget configuration UI to show available markets per store.
 */

import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "./token-crypto.server.js";
import { getCachedMarkets, syncMarketsForShop } from "./sync/market-sync.server.js";

export type { ShopifyMarket } from "./sync/market-sync.server.js";

export async function getMarketsForShop(shopId: string): Promise<import("./sync/market-sync.server.js").ShopifyMarket[]> {
  const cached = getCachedMarkets(shopId);
  if (cached) return cached;

  const db = getDb();
  const [shop] = await db
    .select({ myshopifyDomain: shops.myshopifyDomain, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) return [];

  return syncMarketsForShop(shopId, shop.myshopifyDomain, await decryptToken(shop.accessTokenEncrypted));
}
