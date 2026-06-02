import "@shopify/shopify-api/adapters/node";
import { shopifyApp } from "@shopify/shopify-app-remix/server";
import { ApiVersion } from "@shopify/shopify-api";
import { getDb } from "@promo/db";
import { shops } from "@promo/db";
import { eq } from "drizzle-orm";

export const shopify = shopifyApp({
  apiKey: process.env["SHOPIFY_API_KEY"] ?? "",
  apiSecretKey: process.env["SHOPIFY_API_SECRET"] ?? "",
  apiVersion: ApiVersion.April26,
  scopes: process.env["SCOPES"]?.split(",") ?? [],
  appUrl: process.env["SHOPIFY_APP_URL"] ?? "",
  authPathPrefix: "/auth",
  sessionStorage: {
    /** Custom session storage backed by PostgreSQL via Drizzle. */
    storeSession: async (session) => {
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
          // In production: encrypt accessToken with AES-256-GCM before storing
          accessTokenEncrypted: accessToken,
          currencyCode: "USD", // will be updated on first sync
          timezone: "UTC",
        });
      } else {
        await db
          .update(shops)
          .set({ accessTokenEncrypted: accessToken, updatedAt: new Date() })
          .where(eq(shops.myshopifyDomain, shopDomain));
      }

      return true;
    },

    loadSession: async (id) => {
      // Session ID format: {shop}_{token}
      const [shopDomain] = id.split("_");
      if (!shopDomain) return undefined;

      const db = getDb();
      const rows = await db
        .select()
        .from(shops)
        .where(eq(shops.myshopifyDomain, shopDomain))
        .limit(1);

      const row = rows[0];
      if (!row) return undefined;

      // Reconstruct Shopify session from DB
      const session = {
        id,
        shop: row.myshopifyDomain,
        state: "",
        isOnline: false,
        accessToken: row.accessTokenEncrypted, // decrypt in production
        scope: process.env["SCOPES"] ?? "",
        expires: undefined,
        isExpired: () => false,
        toObject: () => ({ id, shop: row.myshopifyDomain }),
      };

      return session as any;
    },

    deleteSession: async (id) => {
      // Mark as uninstalled rather than hard-delete
      const [shopDomain] = id.split("_");
      if (!shopDomain) return true;
      const db = getDb();
      await db
        .update(shops)
        .set({ isActive: false, uninstalledAt: new Date() })
        .where(eq(shops.myshopifyDomain, shopDomain));
      return true;
    },

    deleteSessions: async (ids) => {
      for (const id of ids) {
        const [shopDomain] = id.split("_");
        if (!shopDomain) continue;
        const db = getDb();
        await db
          .update(shops)
          .set({ isActive: false, uninstalledAt: new Date() })
          .where(eq(shops.myshopifyDomain, shopDomain));
      }
      return true;
    },

    findSessionsByShop: async (shop) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(shops)
        .where(eq(shops.myshopifyDomain, shop))
        .limit(1);

      return rows.map((row) => ({
        id: `${row.myshopifyDomain}_session`,
        shop: row.myshopifyDomain,
        state: "",
        isOnline: false,
        accessToken: row.accessTokenEncrypted,
        scope: process.env["SCOPES"] ?? "",
        expires: undefined,
        isExpired: () => false,
        toObject: () => ({ id: `${row.myshopifyDomain}_session`, shop: row.myshopifyDomain }),
      })) as any[];
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  isEmbeddedApp: true,
});

export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
