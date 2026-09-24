import { shopifyGraphQL } from "../shopify-fetch.server.js";

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
        nodes?: MarketRegionNode[];
        pageInfo?: PageInfo;
      } | null;
    } | null;
  } | null;
  webPresences?: { nodes?: Array<{ defaultLocale?: { locale?: string } | null }> } | null;
}

interface MarketRegionNode {
  __typename?: string;
  code?: string | null;
  country?: { code?: string | null } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export const MARKETS_QUERY = `
  query GetMarkets($after: String) {
    markets(first: 50, after: $after, type: REGION) {
      nodes {
        id name handle status
        currencySettings { baseCurrency { currencyCode } }
        conditions {
          regionsCondition {
            regions(first: 250) {
              nodes {
                __typename
                ... on MarketRegionCountry { code }
                ... on MarketRegionSubdivision { code country { code } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        webPresences(first: 5) { nodes { defaultLocale { locale } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const MARKET_REGIONS_QUERY = `
  query GetMarketRegions($marketId: ID!, $after: String!) {
    node(id: $marketId) {
      ... on Market {
        conditions {
          regionsCondition {
            regions(first: 250, after: $after) {
              nodes {
                __typename
                ... on MarketRegionCountry { code }
                ... on MarketRegionSubdivision { code country { code } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
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
  const marketNodes: MarketNode[] = [];
  let cursor: string | null = null;

  do {
    const data: { markets: { nodes: MarketNode[]; pageInfo: PageInfo } } = await shopifyGraphQL({
      shopDomain,
      accessToken,
      query: MARKETS_QUERY,
      variables: { after: cursor },
    });
    marketNodes.push(...data.markets.nodes);
    cursor = data.markets.pageInfo.hasNextPage ? data.markets.pageInfo.endCursor : null;
    if (data.markets.pageInfo.hasNextPage && !cursor) {
      throw new Error("Shopify Markets pagination omitted endCursor");
    }
  } while (cursor);

  const hydratedNodes = await Promise.all(marketNodes.map(async (market) => {
    const connection = market.conditions?.regionsCondition?.regions;
    if (!connection?.pageInfo?.hasNextPage) return market;

    const nodes = [...(connection.nodes ?? [])];
    let regionCursor = connection.pageInfo.endCursor;
    while (regionCursor) {
      const page: { node: Pick<MarketNode, "conditions"> | null } = await shopifyGraphQL({
        shopDomain,
        accessToken,
        query: MARKET_REGIONS_QUERY,
        variables: { marketId: market.id, after: regionCursor },
      });
      const regions = page.node?.conditions?.regionsCondition?.regions;
      if (!regions) throw new Error(`Shopify returned no regions for market ${market.id}`);
      nodes.push(...(regions.nodes ?? []));
      regionCursor = regions.pageInfo?.hasNextPage ? regions.pageInfo.endCursor : null;
      if (regions.pageInfo?.hasNextPage && !regionCursor) {
        throw new Error(`Shopify region pagination omitted endCursor for market ${market.id}`);
      }
    }

    return {
      ...market,
      conditions: {
        ...market.conditions,
        regionsCondition: {
          ...market.conditions?.regionsCondition,
          regions: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    };
  }));

  const markets = hydratedNodes.map(mapMarketNode);

  marketCache.set(shopId, { data: markets, expiresAt: Date.now() + CACHE_TTL_MS });
  return markets;
}
