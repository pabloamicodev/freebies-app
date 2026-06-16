import { getDb, shops, offers, offerConditions, offerRewards, offerCombinationPolicies } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { SHOPIFY_API_VERSION } from "@promo/shared-types";
import { decryptToken } from "../token-crypto.server.js";
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

  const [conditionRows, rewardRows, policyRows] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.shopId, shopId)),
    db.select().from(offerRewards).where(eq(offerRewards.shopId, shopId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.shopId, shopId)),
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
    console.warn(`[offer-publisher] Config ${sizeBytes}B exceeds ${MAX_METAFIELD_BYTES}B — consider reducing active offers`);
  }

  await pushMetafield(shopDomain, accessToken, config);

  for (const compiledOffer of compiledOffers) {
    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer, updatedAt: new Date() })
      .where(eq(offers.id, compiledOffer.id));
  }
}

async function shopGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);

  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join(", ")}`);
  if (!body.data) throw new Error("Shopify GraphQL returned no data");
  return body.data;
}

async function pushMetafield(
  shopDomain: string,
  accessToken: string,
  config: CompiledFunctionConfig,
): Promise<void> {
  const shopData = await shopGraphQL<{ shop: { id: string } }>(shopDomain, accessToken, `query { shop { id } }`);
  const ownerId = shopData.shop.id;

  const data = await shopGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(
    shopDomain,
    accessToken,
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }`,
    {
      metafields: [{
        ownerId,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(config),
      }],
    },
  );

  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0) throw new Error(`Metafield errors: ${errors.map((e) => e.message).join(", ")}`);
}
