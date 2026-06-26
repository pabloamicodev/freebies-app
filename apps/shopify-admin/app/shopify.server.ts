import "./lib/pg-ssl-patch.js";
import "@shopify/shopify-app-react-router/adapters/node";
import * as Sentry from "@sentry/node";

// ── Startup env validation ────────────────────────────────────────────────────
// Fail at module load time, not on the first request. Vercel surfaces this
// as a deployment error rather than a runtime 500 mid-traffic.
{
  const always = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "DATABASE_URL", "SHOPIFY_APP_URL"];
  const prodOnly = ["TOKEN_ENCRYPTION_KEY", "CRON_SECRET"];
  const isProdEnv = (process.env["NODE_ENV"] ?? "production") === "production";
  const required = isProdEnv ? [...always, ...prodOnly] : always;
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`[startup] Missing required environment variables: ${missing.join(", ")}`);
  }
}
import { shopifyApp } from "@shopify/shopify-app-react-router/server";

if (process.env["SENTRY_DSN"]) {
  const isProd = (process.env["NODE_ENV"] ?? "production") === "production";
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: process.env["NODE_ENV"] ?? "production",
    // Lower sample rate in dev/staging to reduce noise; full rate in prod
    tracesSampleRate: isProd ? 0.15 : 0.01,
    beforeSend(event, hint) {
      // Drop 404s and bot-sourced errors — not actionable
      const status = (hint?.originalException as { status?: number })?.status;
      if (status === 404 || status === 401) return null;
      const ua = (event.request?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "";
      if (/bot|crawler|spider|slurp|baiduspider/i.test(ua)) return null;
      return event;
    },
    beforeSendTransaction(event) {
      // Drop health-check and cron noise from performance data
      const name = event.transaction ?? "";
      if (/health|ping|favicon/i.test(name)) return null;
      return event;
    },
  });
}
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { getDb, shops } from "@promo/db";
import { SHOPIFY_API_VERSION } from "./lib/shopify-api-version.js";
import { encryptToken } from "./lib/token-crypto.server.js";
import { shopifyGraphQL } from "./lib/shopify-fetch.server.js";
import { syncAllProducts } from "./lib/sync/product-sync.server.js";
import { productCache } from "@promo/db";
import { count, eq as drizzleEq } from "drizzle-orm";

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

      // Trigger initial product catalog sync for new shops (no products cached yet).
      // Fire-and-forget — don't block the auth response; sync runs in the background.
      try {
        const db2 = getDb();
        const shopRows2 = await db2
          .select({ id: shops.id, currencyCode: shops.currencyCode })
          .from(shops)
          .where(drizzleEq(shops.myshopifyDomain, session.shop))
          .limit(1);
        const shopRow2 = shopRows2[0];
        if (shopRow2) {
          const [countRow] = await db2
            .select({ n: count() })
            .from(productCache)
            .where(drizzleEq(productCache.shopId, shopRow2.id));
          if ((countRow?.n ?? 0) === 0) {
            syncAllProducts(
              shopRow2.id,
              session.shop,
              session.accessToken ?? "",
              shopRow2.currencyCode ?? "USD",
            ).catch((e: unknown) => {
              Sentry.captureException(e, { extra: { shop: session.shop, context: "afterAuth-product-sync" } });
              console.error("[afterAuth] Initial product sync failed:", e instanceof Error ? e.message : e);
            });
          }
        }
      } catch (syncErr) {
        // Non-fatal — sync can be re-triggered from the UI
        console.error("[afterAuth] Could not check/trigger product sync:", syncErr instanceof Error ? syncErr.message : syncErr);
      }
    },
  },
  isEmbeddedApp: true,
});

export const authenticate = shopify.authenticate;
export const login = shopify.login;
