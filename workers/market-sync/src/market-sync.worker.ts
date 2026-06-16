/**
 * Market Sync Worker
 * Syncs Shopify Markets (currencies, country codes, locales) to Redis cache.
 * Triggered by:
 * - App install (initial sync)
 * - markets/* webhooks
 * - Hourly scheduled refresh
 */

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type Redis from "ioredis";
import pino from "pino";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";
import { SHOPIFY_API_VERSION } from "@promo/shared-types";

const log = pino({ name: "market-sync-worker" });
const MARKET_CACHE_TTL = 3600; // 1 hour

async function decryptAccessToken(stored: string): Promise<string> {
  const sep = stored.indexOf(":");
  if (sep === -1) return stored;
  const keyHex = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!keyHex) return stored;
  try {
    const key = await crypto.subtle.importKey("raw", Buffer.from(keyHex, "hex"), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(stored.slice(0, sep), "hex") }, key, Buffer.from(stored.slice(sep + 1), "hex"));
    return new TextDecoder().decode(plaintext);
  } catch { return stored; }
}

export interface MarketSyncJobData {
  shopId: string;
  shopDomain: string;
}

interface ShopifyMarket {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencySettings: {
    baseCurrency: { currencyCode: string };
    localCurrencies: { currencyCode: string; enabled: boolean }[];
  };
  regions: {
    nodes: Array<{
      id: string;
      name: string;
      countries: { nodes: Array<{ code: string }> };
    }>;
  };
}

const MARKETS_QUERY = `
  query GetMarkets {
    markets(first: 50) {
      nodes {
        id name handle enabled primary
        currencySettings {
          baseCurrency { currencyCode }
          localCurrencies { currencyCode enabled }
        }
        regions(first: 50) {
          nodes {
            id name
            countries(first: 10) { nodes { code } }
          }
        }
      }
    }
  }
`;

export function startMarketSyncWorker(redis: Redis) {
  const worker = new Worker<MarketSyncJobData>(
    "market-sync",
    async (job: Job<MarketSyncJobData>) => {
      const { shopId, shopDomain } = job.data;
      log.info({ shopDomain }, "Starting market sync");

      const db = getDb();
      const shopRow = await db.select({ accessTokenEncrypted: shops.accessTokenEncrypted })
        .from(shops).where(eq(shops.id, shopId)).limit(1).then((r) => r[0]);
      if (!shopRow) throw new Error(`Shop ${shopId} not found`);
      const accessToken = await decryptAccessToken(shopRow.accessTokenEncrypted);

      const response = await fetch(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query: MARKETS_QUERY }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        throw new Error(`Markets API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: { markets: { nodes: ShopifyMarket[] } };
        errors?: unknown[];
      };

      if (data.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(data.errors[0])}`);
      const markets = data.data?.markets.nodes ?? [];
      const cacheKey = `markets:${shopId}`;
      const tmpKey = `markets:${shopId}:tmp`;

      // Write all market data to a temp key first, then atomically rename it
      // over the live key so readers never see an empty/partial cache.
      const pipeline = redis.pipeline();
      pipeline.del(tmpKey);
      for (const market of markets) {
        const marketData = {
          id: market.id,
          name: market.name,
          handle: market.handle,
          enabled: market.enabled,
          primary: market.primary,
          currencyCode: market.currencySettings.baseCurrency.currencyCode,
          countryCodes: market.regions.nodes
            .flatMap((r) => r.countries.nodes.map((c) => c.code))
            .join(","),
        };
        pipeline.hset(tmpKey, market.handle, JSON.stringify(marketData));
      }
      pipeline.expire(tmpKey, MARKET_CACHE_TTL);
      await pipeline.exec();

      // RENAME is atomic — readers see either the old complete data or the new complete data.
      if (markets.length > 0) {
        await redis.rename(tmpKey, cacheKey);
      } else {
        await redis.del(cacheKey);
        await redis.del(tmpKey);
      }

      log.info({ shopDomain, marketCount: markets.length }, "Markets synced to Redis");
    },
    { connection: redis, concurrency: 2, lockDuration: 60_000 },
  );

  worker.on("failed", (job, err) => {
    log.error(
      { jobId: job?.id, shopDomain: job?.data.shopDomain, err: err.message },
      "market-sync job failed permanently",
    );
  });

  return worker;
}
