/**
 * Market sync — fetches Shopify Markets from Admin API and caches in Redis.
 * Used by widget configuration UI to show available markets per store.
 */

import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

const SHOPIFY_API_VERSION = "2026-04";
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
        enabled
        primary
        currencySettings {
          baseCurrency { currencyCode }
        }
        regions(first: 50) {
          nodes {
            ... on MarketRegionCountry {
              code
            }
          }
        }
        primaryLocale { locale }
      }
    }
  }
`;

/**
 * Fetch markets directly from Shopify Admin API.
 */
export async function fetchMarketsFromShopify(
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyMarket[]> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: MARKETS_QUERY }),
    },
  );

  if (!response.ok) {
    throw new Error(`Markets API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data: {
      markets: {
        nodes: Array<{
          id: string;
          name: string;
          handle: string;
          enabled: boolean;
          primary: boolean;
          currencySettings: { baseCurrency: { currencyCode: string } };
          regions: { nodes: Array<{ code?: string }> };
          primaryLocale: { locale: string };
        }>;
      };
    };
  };

  return data.data.markets.nodes.map((m) => ({
    id: m.id,
    name: m.name,
    handle: m.handle,
    enabled: m.enabled,
    primary: m.primary,
    currencyCode: m.currencySettings.baseCurrency.currencyCode,
    countryCodes: m.regions.nodes.map((r) => r.code ?? "").filter(Boolean),
    primaryLocale: m.primaryLocale.locale,
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

/**
 * Invalidate the markets cache for a shop (called after markets webhook).
 */
export async function invalidateMarketsCache(shopId: string): Promise<void> {
  try {
    const { redis } = await import("./queues.server.js");
    await redis.del(`markets:${shopId}`);
  } catch {}
}
