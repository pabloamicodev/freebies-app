export interface MarketRuntimeConfig {
  marketId?: string | null;
  marketHandle?: string | null;
  countryCode?: string | null;
  currency: string;
  locale: string;
}

export interface ShopifyStorefrontContext {
  currency?: { active?: string; rate?: string | number };
  country?: string;
  locale?: string;
}

export function buildMarketContext(
  config: MarketRuntimeConfig,
  shopify: ShopifyStorefrontContext | undefined,
) {
  if (!config.marketId) return null;

  const rate = Number(shopify?.currency?.rate);
  return {
    id: config.marketId,
    handle: config.marketHandle ?? "",
    currencyCode: shopify?.currency?.active ?? config.currency,
    countryCode: config.countryCode ?? shopify?.country ?? null,
    primaryLocale: shopify?.locale ?? config.locale,
    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}
