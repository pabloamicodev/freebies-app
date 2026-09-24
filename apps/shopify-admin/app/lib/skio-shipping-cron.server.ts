import { and, eq } from "drizzle-orm";
import { appSettings, shops, type Db } from "@promo/db";
import { decryptToken } from "./token-crypto.server.js";
import { SKIO_API_KEY_SETTING } from "./skio-credentials.server.js";
import { loadSkioShippingConfig } from "./skio-shipping-config.server.js";
import { runSkioShippingSync } from "./skio-shipping-runner.server.js";
import { makeSkioGraphQLProxy } from "./skio-api.server.js";

export interface SkioCronResult {
  shopsProcessed: number;
  shopsFailed: number;
  subscriptionsMatched: number;
  overridesApplied: number;
  errors: Array<{ shopDomain: string; message: string }>;
}

export async function runAllSkioShippingSyncs(db: Db): Promise<SkioCronResult> {
  const connections = await db
    .select({
      shopDomain: shops.myshopifyDomain,
      accessTokenEncrypted: shops.accessTokenEncrypted,
      skioApiKeyEncrypted: appSettings.value,
    })
    .from(shops)
    .innerJoin(
      appSettings,
      and(eq(appSettings.shopId, shops.id), eq(appSettings.key, SKIO_API_KEY_SETTING)),
    )
    .where(eq(shops.isActive, true));

  const result: SkioCronResult = {
    shopsProcessed: 0,
    shopsFailed: 0,
    subscriptionsMatched: 0,
    overridesApplied: 0,
    errors: [],
  };

  for (const connection of connections) {
    try {
      const [accessToken, skioApiKey] = await Promise.all([
        decryptToken(connection.accessTokenEncrypted),
        decryptToken(connection.skioApiKeyEncrypted),
      ]);
      const loaded = await loadSkioShippingConfig({ shopDomain: connection.shopDomain, accessToken });
      if (!loaded.configValid) throw new Error(loaded.configError ?? "Invalid Skio shipping configuration.");
      if (loaded.config.tiers.length === 0) {
        result.shopsProcessed += 1;
        continue;
      }

      const subscriptions = await runSkioShippingSync(makeSkioGraphQLProxy(skioApiKey), loaded.config);
      result.shopsProcessed += 1;
      result.subscriptionsMatched += subscriptions.filter((entry) => entry.matchedTierId !== null).length;
      result.overridesApplied += subscriptions.filter((entry) => entry.applied).length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.shopsFailed += 1;
      result.errors.push({ shopDomain: connection.shopDomain, message });
      console.error("[cron:skio-shipping] shop failed", { shopDomain: connection.shopDomain, error });
    }
  }

  return result;
}
