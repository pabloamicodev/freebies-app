/**
 * Offer Publisher Worker
 * Compiles active offers into compact JSON configs and pushes them
 * to Shopify metafields so the Rust Discount Function can read them.
 *
 * Triggered when:
 * - An offer is published or updated
 * - An offer is paused or archived
 * - Metafield config is stale (scheduled refresh)
 */

import { Worker, type Job } from "bullmq";
import { redis } from "../../product-sync/src/queues.js";
import { getDb, shops, offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq, and } from "drizzle-orm";

/**
 * AES-256-GCM token decryption — mirrors token-crypto.server.ts.
 * Falls back to plaintext for legacy tokens (no ":" separator).
 */
async function decryptAccessToken(stored: string): Promise<string> {
  const separatorIndex = stored.indexOf(":");
  if (separatorIndex === -1) return stored; // Legacy plaintext

  const keyHex = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!keyHex) return stored; // No key configured

  try {
    const keyBytes = Buffer.from(keyHex, "hex");
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const iv = Buffer.from(stored.slice(0, separatorIndex), "hex");
    const ciphertext = Buffer.from(stored.slice(separatorIndex + 1), "hex");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return stored;
  }
}
import pino from "pino";
import { compileOfferConfig, estimateConfigSize, type CompiledFunctionConfig } from "./compile-config.js";

const log = pino({ name: "offer-publisher-worker" });

const SHOPIFY_API_VERSION = "2026-04";
const METAFIELD_NAMESPACE = "promo_engine";
const METAFIELD_KEY = "function_config";
const MAX_METAFIELD_BYTES = 9500; // Leave headroom under 10KB limit

export interface OfferPublishJobData {
  shopId?: string;
  shopDomain: string;
  /** Specific offer ID that changed, or null for full rebuild. */
  offerId?: string;
}

export function startOfferPublisherWorker() {
  return new Worker<OfferPublishJobData>(
    "offer-publish",
    async (job: Job<OfferPublishJobData>) => {
      const { shopDomain } = job.data;
      log.info({ shopDomain, offerId: job.data.offerId }, "Starting offer config publish");

      const db = getDb();

      // Look up shop from DB to get decrypted access token — never passed plaintext through Redis
      const shopRows = await db
        .select({ id: shops.id, accessTokenEncrypted: shops.accessTokenEncrypted })
        .from(shops)
        .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
        .limit(1);

      const [shopRow] = shopRows;

      if (!shopRow) {
        log.warn({ shopDomain }, "Shop not found or inactive — skipping publish");
        return;
      }

      const shopId = job.data.shopId ?? shopRow.id;
      const accessToken = await decryptAccessToken(shopRow.accessTokenEncrypted);

      // Load all active offers for this shop
      const activeOffers = await db
        .select()
        .from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

      if (activeOffers.length === 0) {
        // No active offers — clear the metafield
        await pushMetafield(shopDomain, accessToken, { offers: [], version: "1", compiledAt: new Date().toISOString() });
        log.info({ shopDomain }, "No active offers — cleared function config metafield");
        return;
      }

      // Load all conditions, rewards, policies for active offers
      const offerIds = activeOffers.map((o) => o.id);
      const [conditionRows, rewardRows, policyRows] = await Promise.all([
        db.select().from(offerConditions).where(eq(offerConditions.shopId, shopId)),
        db.select().from(offerRewards).where(eq(offerRewards.shopId, shopId)),
        db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.shopId, shopId)),
      ]);

      // Compile each offer
      const compiledOffers = activeOffers
        .sort((a, b) => a.priority - b.priority) // Sort by priority ascending
        .map((offer, idx) => {
          const conditions = conditionRows.filter((c) => c.offerId === offer.id);
          const rewards = rewardRows.filter((r) => r.offerId === offer.id);
          const policy = policyRows.find((p) => p.offerId === offer.id) ?? null;
          return compileOfferConfig(offer, conditions, rewards, policy, idx + 1);
        });

      const config: CompiledFunctionConfig = {
        offers: compiledOffers,
        version: "1",
        compiledAt: new Date().toISOString(),
      };

      // Check size — warn if approaching limit
      const sizeBytes = estimateConfigSize(config);
      if (sizeBytes > MAX_METAFIELD_BYTES) {
        log.warn(
          { shopDomain, sizeBytes, maxBytes: MAX_METAFIELD_BYTES },
          "Function config exceeds safe metafield size — consider sharding or reducing active offers",
        );
      }

      // Push to Shopify metafield on the shop resource
      await pushMetafield(shopDomain, accessToken, config);

      // Update compiled_config in DB for each offer
      for (const compiledOffer of compiledOffers) {
        await db
          .update(offers)
          .set({ compiledConfig: compiledOffer as any, updatedAt: new Date() })
          .where(eq(offers.id, compiledOffer.id));
      }

      log.info(
        { shopDomain, offerCount: compiledOffers.length, sizeBytes },
        "Offer config published to metafield",
      );
    },
    {
      connection: redis,
      concurrency: 2,
    },
  );
}

async function pushMetafield(
  shopDomain: string,
  accessToken: string,
  config: CompiledFunctionConfig,
): Promise<void> {
  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/Shop/1`, // Will be resolved via separate query in production
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(config),
            },
          ],
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Metafield push failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data: { metafieldsSet: { userErrors: Array<{ message: string }> } };
  };

  const errors = data.data.metafieldsSet.userErrors;
  if (errors.length > 0) {
    throw new Error(`Metafield user errors: ${errors.map((e) => e.message).join(", ")}`);
  }
}
