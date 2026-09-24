import { SHOPIFY_API_VERSION } from "@promo/shared-types";

export interface ShopifyMarket {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencyCode: string;
  countryCodes: string[];
  primaryLocale: string;
}

export interface MarketNode {
  id: string;
  name: string;
  handle: string;
  status: string;
  currencySettings?: { baseCurrency?: { currencyCode?: string } | null } | null;
  conditions?: {
    regionsCondition?: {
      regions?: {
        nodes?: Array<{
          __typename?: string;
          code?: string | null;
          country?: { code?: string | null } | null;
        }>;
      } | null;
    } | null;
  } | null;
  webPresences?: { nodes?: Array<{ defaultLocale?: { locale?: string } | null }> } | null;
}

export const MARKETS_QUERY = `
  query GetMarkets {
    markets(first: 50) {
      nodes {
        id name handle status
        currencySettings { baseCurrency { currencyCode } }
        conditions {
          regionsCondition {
            regions(first: 250) {
              nodes {
                __typename
                ... on MarketRegionCountry { code }
              }
            }
          }
        }
        webPresences(first: 5) { nodes { defaultLocale { locale } } }
      }
    }
  }
`;

export function mapMarketNode(market: MarketNode): ShopifyMarket {
  const countryCodes = market.conditions?.regionsCondition?.regions?.nodes?.flatMap((region) => {
    const code = region.__typename === "MarketRegionSubdivision"
      ? region.country?.code
      : region.code;
    return code ? [code] : [];
  }) ?? [];

  return {
    id: market.id,
    name: market.name,
    handle: market.handle,
    enabled: market.status === "ACTIVE",
    // Shopify deprecated Market.primary in favor of the shop-level backupRegion
    // query, which does not map back to a Market GID. Keep this presentation-only
    // flag false rather than querying a deprecated field.
    primary: false,
    currencyCode: market.currencySettings?.baseCurrency?.currencyCode ?? "USD",
    countryCodes: [...new Set(countryCodes)],
    primaryLocale: market.webPresences?.nodes?.[0]?.defaultLocale?.locale ?? "en",
  };
}

// Module-level cache — shared across warm function invocations within the same instance
const marketCache = new Map<string, { data: ShopifyMarket[]; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getCachedMarkets(shopId: string): ShopifyMarket[] | null {
  const entry = marketCache.get(shopId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}

export function invalidateMarketsCache(shopId: string): void {
  marketCache.delete(shopId);
}

export async function syncMarketsForShop(
  shopId: string,
  shopDomain: string,
  accessToken: string,
): Promise<ShopifyMarket[]> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: MARKETS_QUERY }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) throw new Error(`Markets API error: ${response.status}`);

  const data = (await response.json()) as {
    data?: { markets: { nodes: MarketNode[] } };
    errors?: unknown[];
  };

  if (data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);

  const markets = (data.data?.markets?.nodes ?? []).map(mapMarketNode);

  marketCache.set(shopId, { data: markets, expiresAt: Date.now() + CACHE_TTL_MS });
  return markets;
}
