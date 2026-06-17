import { getDb, shops, offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq, and, inArray } from "drizzle-orm";
import { decryptToken } from "../token-crypto.server.js";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import { compileOfferConfig, estimateConfigSize, type CompiledFunctionConfig } from "./compile-config.js";

const METAFIELD_NAMESPACE = "promo_engine";
const METAFIELD_KEY = "function_config";
const MAX_METAFIELD_BYTES = 9500;

export async function publishOffersForShop(shopId: string, shopDomain: string): Promise<void> {
  const db = getDb();

  const [shopRow] = await db
    .select({ accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  if (!shopRow) return;

  const accessToken = await decryptToken(shopRow.accessTokenEncrypted);

  const activeOffers = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

  if (activeOffers.length === 0) {
    await pushMetafield(shopDomain, accessToken, { offers: [], version: "1", compiledAt: new Date().toISOString() });
    return;
  }

  const activeOfferIds = activeOffers.map((offer) => offer.id);
  const [conditionRows, rewardRows, policyRows] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, activeOfferIds))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, activeOfferIds))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, activeOfferIds))),
  ]);

  const compiledOffers = activeOffers
    .sort((a, b) => a.priority - b.priority)
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

  const sizeBytes = estimateConfigSize(config);
  if (sizeBytes > MAX_METAFIELD_BYTES) {
    throw new Error(`Function config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit. Pause or simplify active offers before publishing.`);
  }

  await pushMetafield(shopDomain, accessToken, config);

  for (const compiledOffer of compiledOffers) {
    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer, updatedAt: new Date() })
      .where(eq(offers.id, compiledOffer.id));
  }
}

async function pushMetafield(
  shopDomain: string,
  accessToken: string,
  config: CompiledFunctionConfig,
): Promise<void> {
  const shopData = await shopifyGraphQL<{ shop: { id: string } }>({
    shopDomain,
    accessToken,
    query: `query { shop { id } }`,
  });
  const ownerId = shopData.shop.id;

  const data = await shopifyGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>({
    shopDomain,
    accessToken,
    query: `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }`,
    variables: {
      metafields: [{
        ownerId,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(config),
      }],
    },
  });

  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0) throw new Error(`Metafield errors: ${errors.map((e) => e.message).join(", ")}`);
}
