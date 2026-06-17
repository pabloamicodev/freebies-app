import "./lib/pg-ssl-patch.js";
import "@shopify/shopify-app-react-router/adapters/node";
import { shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { getDb, shops } from "@promo/db";
import { SHOPIFY_API_VERSION } from "./lib/shopify-api-version.js";
import { eq } from "drizzle-orm";
import { encryptToken } from "./lib/token-crypto.server.js";

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
        console.error("Webhook registration failed:", e);
      }

      // Mirror shop record to PostgreSQL for offer management
      try {
        const db = getDb();
        const shopDomain = session.shop;
        const rawToken = session.accessToken ?? "";
        const accessTokenEncrypted = await encryptToken(rawToken);

        const existing = await db
          .select({ id: shops.id })
          .from(shops)
          .where(eq(shops.myshopifyDomain, shopDomain))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(shops).values({
            shopDomain,
            myshopifyDomain: shopDomain,
            accessTokenEncrypted,
            currencyCode: "USD",
            timezone: "UTC",
          });
        } else {
          await db
            .update(shops)
            .set({ accessTokenEncrypted, isActive: true, updatedAt: new Date() })
            .where(eq(shops.myshopifyDomain, shopDomain));
        }
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
