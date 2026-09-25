function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
}

function parseMyShopifyUrl(value: string): URL {
  const url = parseUrl(value, "DEV_STORE_URL");
  if (url.protocol !== "https:" || !url.hostname.endsWith(".myshopify.com")) {
    throw new Error("DEV_STORE_URL must be an HTTPS myshopify.com URL.");
  }
  return url;
}

export function buildShopifyOAuthUrl(appUrl: string, devStoreUrl: string): string {
  const app = parseUrl(appUrl, "APP_URL");
  const shop = parseMyShopifyUrl(devStoreUrl);
  const oauthUrl = new URL("/auth/login", app.origin);
  oauthUrl.searchParams.set("shop", shop.hostname);
  return oauthUrl.toString();
}

export function isStorefrontPasswordUrl(currentUrl: string, devStoreUrl: string): boolean {
  const current = parseUrl(currentUrl, "Current page URL");
  const shop = parseMyShopifyUrl(devStoreUrl);
  return current.origin === shop.origin && current.pathname.replace(/\/$/, "") === "/password";
}
