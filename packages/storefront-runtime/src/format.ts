/** Locale used for number/currency formatting: the storefront's (market) locale, not the browser's. */
export function storefrontLocale(): string {
  const fromShopify = typeof window !== "undefined" ? window.Shopify?.locale : undefined;
  const fromDoc = typeof document !== "undefined" ? document.documentElement?.lang : undefined;
  const fromNav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return fromShopify || fromDoc || fromNav || "en-US";
}

/** Active presentment currency: the cart's, then Shopify's, then the caller's fallback. */
export function storefrontCurrency(fallback?: string | null): string {
  const active = typeof window !== "undefined" ? window.Shopify?.currency?.active : undefined;
  return fallback || active || "USD";
}

export function formatMoney(cents: number, currency?: string | null): string {
  const code = storefrontCurrency(currency);
  for (const locale of [storefrontLocale(), "en-US"]) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(cents / 100);
    } catch {
      // Malformed locale tag or unknown currency code: try the next candidate.
    }
  }
  return `${(cents / 100).toFixed(2)} ${code}`;
}
