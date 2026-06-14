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

// NOTE: `enabled`, `primary`, `regions` and `primaryLocale` are deprecated on
// the Market object as of 2024-2025 (superseded by `status`, `conditions`,
// `webPresences`). They still resolve in 2026-04 but must be migrated before
// Shopify removes them — that migration requires validating the new nested
// shapes (MarketConditions / MarketWebPresence) against a live store.
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

interface MarketNode {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencySettings?: { baseCurrency?: { currencyCode?: string } | null } | null;
  regions?: { nodes?: Array<{ code?: string | null }> } | null;
  primaryLocale?: { locale?: string } | null;
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
    enabled: m.enabled,
    primary: m.primary,
    currencyCode: m.currencySettings?.baseCurrency?.currencyCode ?? "USD",
    countryCodes: (m.regions?.nodes ?? []).flatMap((r) => (r.code ? [r.code] : [])),
    primaryLocale: m.primaryLocale?.locale ?? "en",
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
