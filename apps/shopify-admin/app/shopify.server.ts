import "./lib/pg-ssl-patch.js";
import "@shopify/shopify-app-react-router/adapters/node";
import * as Sentry from "@sentry/node";
import { shopifyApp } from "@shopify/shopify-app-react-router/server";

if (process.env["SENTRY_DSN"]) {
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: process.env["NODE_ENV"] ?? "production",
    tracesSampleRate: 0.1,
  });
}
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { getDb, shops } from "@promo/db";
import { SHOPIFY_API_VERSION } from "./lib/shopify-api-version.js";
import { encryptToken } from "./lib/token-crypto.server.js";
import { shopifyGraphQL } from "./lib/shopify-fetch.server.js";

// Strip channel_binding param — Node.js pg library doesn't support it
const rawDbUrl = new URL(
  process.env["DATABASE_URL"] ?? "postgresql://localhost/neondb"
);
rawDbUrl.searchParams.delete("channel_binding");

const sessionStorage = new PostgreSQLSessionStorage(rawDbUrl);

const shopify = shopifyApp({
  apiKey: process.env["SHOPIFY_API_KEY"] ?? "",
  apiSecretKey: process.env["SHOPIFY_API_SECRET"] ?? "",
  apiVersion: SHOPIFY_API_VERSION,
  scopes: process.env["SCOPES"]?.split(",") ?? [],
  appUrl: process.env["SHOPIFY_APP_URL"] ?? "",
  authPathPrefix: "/auth",
  sessionStorage,
  future: {
    // Token exchange strategy is the default in shopify-app-react-router
  },
  hooks: {
    afterAuth: async ({ session }) => {
      try {
        await shopify.registerWebhooks({ session });
      } catch (e) {
        Sentry.captureException(e, { extra: { shop: session.shop, context: "webhook-registration" } });
        console.error("Webhook registration failed:", e);
        // Do not throw — install should succeed even if webhook reg fails (Shopify retries)
      }

      // Mirror shop record to PostgreSQL for offer management
      try {
        const db = getDb();
        const shopDomain = session.shop;
        const rawToken = session.accessToken;

        if (!rawToken) {
          throw new Error(`[afterAuth] Shopify session has no accessToken for shop: ${shopDomain}`);
        }

        const accessTokenEncrypted = await encryptToken(rawToken);

        // Fetch real shop locale from Shopify Admin API.
        // Fall back to safe defaults so install never fails due to a network hiccup.
        let currencyCode = "USD";
        let timezone = "UTC";
        let locale: string | null = null;
        try {
          const shopData = await shopifyGraphQL<{
            shop: { currencyCode: string; ianaTimezone: string; primaryDomain: { localization: { language: { isoCode: string } } } };
          }>({
            shopDomain,
            accessToken: rawToken,
            query: `{ shop { currencyCode ianaTimezone primaryDomain { localization { language { isoCode } } } } }`,
          });
          currencyCode = shopData.shop.currencyCode;
          timezone = shopData.shop.ianaTimezone;
          locale = shopData.shop.primaryDomain?.localization?.language?.isoCode ?? null;
        } catch (shopFetchErr) {
          Sentry.captureException(shopFetchErr, { extra: { shop: shopDomain, context: "afterAuth-shop-fetch" } });
          console.error("[afterAuth] Could not fetch shop locale, using defaults:", shopFetchErr instanceof Error ? shopFetchErr.message : shopFetchErr);
        }

        // Atomic upsert — no TOCTOU race on concurrent installs / reinstalls.
        // On reinstall: token + isActive refreshed; locale fields updated.
        await db
          .insert(shops)
          .values({
            shopDomain,
            myshopifyDomain: shopDomain,
            accessTokenEncrypted,
            currencyCode,
            timezone,
            locale,
          })
          .onConflictDoUpdate({
            target: shops.myshopifyDomain,
            set: {
              accessTokenEncrypted,
              isActive: true,
              currencyCode,
              timezone,
              locale,
              updatedAt: new Date(),
            },
          });
      } catch (dbError) {
        console.error("DB mirror after auth failed:", dbError instanceof Error ? dbError.message : dbError);
        throw dbError;
      }
    },
  },
  isEmbeddedApp: true,
});

export const authenticate = shopify.authenticate;
export const login = shopify.login;
