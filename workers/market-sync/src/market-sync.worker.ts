/**
 * Market Sync Worker
 * Syncs Shopify Markets (currencies, country codes, locales) to Redis cache.
 * Triggered by:
 * - App install (initial sync)
 * - markets/* webhooks
 * - Hourly scheduled refresh
 */

import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import pino from "pino";
import { getDb, shops } from "@promo/db";
import { eq } from "drizzle-orm";

const log = pino({ name: "market-sync-worker" });
const SHOPIFY_API_VERSION = "2026-04";
const MARKET_CACHE_TTL = 3600; // 1 hour

export interface MarketSyncJobData {
  shopId: string;
  shopDomain: string;
  accessToken: string;
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
  return new Worker<MarketSyncJobData>(
    "market-sync",
    async (job: Job<MarketSyncJobData>) => {
      const { shopId, shopDomain, accessToken } = job.data;
      log.info({ shopDomain }, "Starting market sync");

      const response = await fetch(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query: MARKETS_QUERY }),
        },
      );

      if (!response.ok) {
        throw new Error(`Markets API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        data: { markets: { nodes: ShopifyMarket[] } };
      };

      const markets = data.data.markets.nodes;

      // Cache market data in Redis as a hash
      const cacheKey = `markets:${shopId}`;
      const pipeline = redis.pipeline();

      pipeline.del(cacheKey);
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
        pipeline.hset(cacheKey, market.handle, JSON.stringify(marketData));
      }
      pipeline.expire(cacheKey, MARKET_CACHE_TTL);

      await pipeline.exec();

      log.info({ shopDomain, marketCount: markets.length }, "Markets synced to Redis");
    },
    { connection: redis, concurrency: 2 },
  );
}
