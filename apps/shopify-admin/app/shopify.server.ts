import "@shopify/shopify-api/adapters/node";
import { shopifyApp } from "@shopify/shopify-app-remix/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { ApiVersion } from "@shopify/shopify-api";

// Force SSL for pg connections (required by Neon on Vercel)
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
process.env["PGSSLMODE"] = "require";

const sessionStorage = new PostgreSQLSessionStorage(
  new URL(process.env["DATABASE_URL"] ?? "postgresql://localhost/neondb")
);

export const shopify = shopifyApp({
  apiKey: process.env["SHOPIFY_API_KEY"] ?? "",
  apiSecretKey: process.env["SHOPIFY_API_SECRET"] ?? "",
  apiVersion: ApiVersion.October25,
  scopes: process.env["SCOPES"]?.split(",") ?? [],
  appUrl: process.env["SHOPIFY_APP_URL"] ?? "",
  authPathPrefix: "/auth",
  sessionStorage,
  hooks: {
    afterAuth: async ({ session }) => {
      try {
        await shopify.registerWebhooks({ session });
      } catch (e) {
        console.error("Webhook registration failed:", e);
      }

      // Mirror shop record to PostgreSQL for offer management
      try {
        const { getDb } = await import("@promo/db");
        const { shops } = await import("@promo/db");
        const { eq } = await import("drizzle-orm");
        const db = getDb();
        const shopDomain = session.shop;
        const accessToken = session.accessToken ?? "";

        const existing = await db
          .select({ id: shops.id })
          .from(shops)
          .where(eq(shops.myshopifyDomain, shopDomain))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(shops).values({
            shopDomain,
            myshopifyDomain: shopDomain,
            accessTokenEncrypted: accessToken,
            currencyCode: "USD",
            timezone: "UTC",
          });
        } else {
          await db
            .update(shops)
            .set({ accessTokenEncrypted: accessToken, isActive: true, updatedAt: new Date() })
            .where(eq(shops.myshopifyDomain, shopDomain));
        }
      } catch (dbError) {
        console.warn("DB mirror after auth failed (non-fatal):", dbError instanceof Error ? dbError.message : dbError);
      }
    },
  },
  isEmbeddedApp: true,
});

export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
