import { and, eq } from "drizzle-orm";
import { getDb, shops } from "@promo/db";
import { verifyAppProxySignature } from "./app-proxy-auth.server.js";
import { createMemoryCache } from "./memory-cache.server.js";
import { redisDelete, redisGetString, redisSetString } from "./redis.server.js";

/**
 * D10: the active-shop row is read on every storefront request. Cached 30s in Redis
 * (id, currency and the ENCRYPTED access token only; useless without TOKEN_ENCRYPTION_KEY).
 * Misses are never cached, so a freshly installed shop works immediately; an uninstall is
 * seen within SHOP_CACHE_TTL_SECONDS, or at once if the webhook calls invalidateShopCache.
 */
export const SHOP_CACHE_TTL_SECONDS = 30;

type CachedShop = Pick<typeof shops.$inferSelect, "id" | "currencyCode" | "accessTokenEncrypted">;

const l1 = createMemoryCache<string>();
const key = (shopDomain: string) => `shop:v1:${shopDomain}`;

export function invalidateShopCache(shopDomain: string): Promise<void> {
  l1.delete(key(shopDomain));
  return redisDelete(key(shopDomain)).catch(() => undefined);
}

export async function loadActiveShop(shopDomain: string) {
  const db = getDb();
  const hot = l1.get(key(shopDomain));
  const cached = hot ?? (await redisGetString(key(shopDomain)));
  if (cached) {
    try {
      const shop = JSON.parse(cached) as CachedShop;
      if (hot === undefined) l1.set(key(shopDomain), cached);
      return { ...shop, shopDomain, db };
    } catch {
      // Corrupt entry: refetch below.
    }
  }
  const rows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);
  const shop = rows[0];
  if (!shop) throw new Response("Shop not found or app uninstalled", { status: 404 });
  const serialized = JSON.stringify(shop);
  l1.set(key(shopDomain), serialized);
  await redisSetString(key(shopDomain), serialized, SHOP_CACHE_TTL_SECONDS);
  return { ...shop, shopDomain, db };
}

/** Drop-in for getSignedShop (same return shape) with the cached shop lookup. */
export async function getSignedShopCached(request: Request) {
  const shopDomain = verifyAppProxySignature(request);
  const shop = await loadActiveShop(shopDomain);
  // Shopify signs this into the proxy request when the visitor is logged in; the client cannot forge it.
  const loggedInCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  return { ...shop, loggedInCustomerId };
}
