export interface MarketRuntimeConfig {
  /** Liquid renders `localization.market.id` as a number; tests and older configs pass a GID. */
  marketId?: string | number | null;
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
  const rawId = String(config.marketId);
  return {
    id: /^\d+$/.test(rawId) ? `gid://shopify/Market/${rawId}` : rawId,
    handle: config.marketHandle ?? "",
    currencyCode: shopify?.currency?.active ?? config.currency,
    countryCode: config.countryCode ?? shopify?.country ?? null,
    primaryLocale: shopify?.locale ?? config.locale,
    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}
