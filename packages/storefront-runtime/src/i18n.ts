/**
 * Widget strings. English defaults; the app embed overrides them from the theme
 * extension's locale files (`window.__promoEngineConfig.i18n`), so merchants translate
 * them through the standard Shopify locale mechanism.
 */
const DEFAULTS = {
  close: "Close",
  giftOffer: "View free gift offer",
  giftSliderClose: "Close gift selection",
  giftsUpdating: "Updating gifts",
  progress: "Progress: {{percent}}%",
  todayOffers: "Today's offers",
  todayDeals: "Today's Deals",
  offersAvailable: "{{count}} offers available",
  offerAvailable: "1 offer available",
  bundleSearch: "Search products in this step",
  bundleAdd: "Add {{title}}",
  bundleRemove: "Remove {{title}}",
  fbtAdd: "Add {{count}} item(s) to cart for {{price}}",
  volumeTier: "Buy {{quantity}}+ for {{price}} each",
} as const;

export type I18nKey = keyof typeof DEFAULTS;

export function t(key: I18nKey, vars: Record<string, string | number> = {}): string {
  const custom = typeof window !== "undefined" ? window.__promoEngineConfig?.i18n?.[key] : undefined;
  const template = typeof custom === "string" && custom ? custom : DEFAULTS[key];
  // The app embed renders placeholders as __name__ (a literal "{{" inside a Liquid output tag would
  // end the tag early); the built-in defaults use {{name}}.
  return template.replace(/\{\{\s*(\w+)\s*\}\}|__(\w+)__/g, (m, braced: string | undefined, underscored: string | undefined) => {
    const name = braced ?? underscored ?? "";
    return name in vars ? String(vars[name]) : m;
  });
}
