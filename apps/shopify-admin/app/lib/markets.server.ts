/**
 * Market sync — fetches Shopify Markets from Admin API and caches in Redis.
 * Used by widget configuration UI to show available markets per store.
 */

import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

const MARKETS_CACHE_TTL = 3600; // 1 hour

export interface ShopifyMarket {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencyCode: string;
  /** Country codes included in this market. */
  countryCodes: string[];
  primaryLocale: string;
}

const MARKETS_QUERY = `
  query GetMarkets {
    markets(first: 50) {
      nodes {
        id
        name
        handle
        status
        currencySettings {
          baseCurrency { currencyCode }
        }
        conditions {
          allMarkets
          countries { code }
        }
        webPresences(first: 5) {
          nodes {
            defaultLocale { locale }
          }
        }
      }
    }
  }
`;

interface MarketNode {
  id: string;
  name: string;
  handle: string;
  status: string;
  currencySettings?: { baseCurrency?: { currencyCode?: string } | null } | null;
  conditions?: { allMarkets?: boolean; countries?: Array<{ code?: string | null }> } | null;
  webPresences?: { nodes?: Array<{ defaultLocale?: { locale?: string } | null }> } | null;
}

/**
 * Fetch markets directly from Shopify Admin API (resilient: retries on
 * throttling / transient errors). Null-safe against partial market payloads.
 */
async function fetchMarketsFromShopify(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyMarket[]> {
  const data = await shopifyGraphQL<{ markets: { nodes: MarketNode[] } }>({
    shopDomain,
    accessToken,
    query: MARKETS_QUERY,
  });

  return (data.markets?.nodes ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    handle: m.handle,
    enabled: m.status === "ACTIVE",
    primary: m.conditions?.allMarkets ?? false,
    currencyCode: m.currencySettings?.baseCurrency?.currencyCode ?? "USD",
    countryCodes: (m.conditions?.countries ?? []).flatMap((c) => (c.code ? [c.code] : [])),
    primaryLocale: m.webPresences?.nodes?.[0]?.defaultLocale?.locale ?? "en",
  }));
}

/**
 * Get markets for a shop — from Redis cache, or fetch from Shopify and cache.
 */
export async function getMarketsForShop(shopId: string): Promise<ShopifyMarket[]> {
  // Try Redis cache first
  try {
    const { redis } = await import("./queues.server.js");
    const cacheKey = `markets:${shopId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as ShopifyMarket[];
  } catch {}

  // Cache miss — fetch from Shopify
  const db = getDb();
  const [shop] = await db
    .select({ myshopifyDomain: shops.myshopifyDomain, accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) return [];

  const { decryptToken } = await import("./token-crypto.server.js");
  const markets = await fetchMarketsFromShopify(
    shop.myshopifyDomain,
    await decryptToken(shop.accessTokenEncrypted),
  );

  // Cache in Redis
  try {
    const { redis } = await import("./queues.server.js");
    await redis.setex(`markets:${shopId}`, MARKETS_CACHE_TTL, JSON.stringify(markets));
  } catch {}

  return markets;
}
