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

interface MarketNode {
  id: string;
  name: string;
  handle: string;
  status: string;
  currencySettings?: { baseCurrency?: { currencyCode?: string } | null } | null;
  conditions?: { allMarkets?: boolean; countries?: Array<{ code?: string | null }> } | null;
  webPresences?: { nodes?: Array<{ defaultLocale?: { locale?: string } | null }> } | null;
}

const MARKETS_QUERY = `
  query GetMarkets {
    markets(first: 50) {
      nodes {
        id name handle status
        currencySettings { baseCurrency { currencyCode } }
        conditions { allMarkets countries { code } }
        webPresences(first: 5) { nodes { defaultLocale { locale } } }
      }
    }
  }
`;

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

  const markets = (data.data?.markets?.nodes ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    handle: m.handle,
    enabled: m.status === "ACTIVE",
    primary: m.conditions?.allMarkets ?? false,
    currencyCode: m.currencySettings?.baseCurrency?.currencyCode ?? "USD",
    countryCodes: (m.conditions?.countries ?? []).flatMap((c) => (c.code ? [c.code] : [])),
    primaryLocale: m.webPresences?.nodes?.[0]?.defaultLocale?.locale ?? "en",
  }));

  marketCache.set(shopId, { data: markets, expiresAt: Date.now() + CACHE_TTL_MS });
  return markets;
}
