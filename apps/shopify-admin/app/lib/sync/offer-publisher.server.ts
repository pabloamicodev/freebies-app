import { getDb, shops, offers, offerConditions, offerRewards, offerCombinationPolicies, variantCache, type Offer, type OfferCondition, type OfferReward, type OfferCombinationPolicy } from "@promo/db";
import { eq, and, inArray } from "drizzle-orm";
import { decryptToken } from "../token-crypto.server.js";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import { ensureDiscountNode, syncDiscountCombinationPolicy } from "../discount-node.server.js";
import { buildCartValidationConfig, syncCartValidation } from "../cart-validation.server.js";
import { computeOfferVersion } from "../offer-version.server.js";
import {
  compileOfferConfig,
  compileDiscountCombinationPolicy,
  compileShippingOfferConfigs,
  estimateConfigSize,
  type CompiledFunctionConfig,
} from "./compile-config.js";
import { buildAttributeQueryVariables } from "./attribute-query-variables.js";

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
  // Self-heals if afterAuth's registration failed or hasn't run yet (e.g. the
  // function was deployed after this shop installed the app).
  const discountId = await ensureDiscountNode(shopId, shopDomain, accessToken);

  const activeOffers: Offer[] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

  if (activeOffers.length === 0) {
    const emptyConfig: CompiledFunctionConfig = {
      offers: [],
      shippingOffers: [],
      version: "1",
      compiledAt: new Date().toISOString(),
    };
    await Promise.all([
      pushMetafield(shopDomain, accessToken, discountId, emptyConfig),
      syncCartValidation(shopDomain, accessToken, buildCartValidationConfig([])),
      syncDiscountCombinationPolicy(
        shopDomain,
        accessToken,
        discountId,
        compileDiscountCombinationPolicy([]),
      ),
    ]);
    return;
  }

  const activeOfferIds = activeOffers.map((offer) => offer.id);
  const [conditionRows, rewardRows, policyRows]: [OfferCondition[], OfferReward[], OfferCombinationPolicy[]] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, activeOfferIds))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, activeOfferIds))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, activeOfferIds))),
  ]);

  const compiledByOffer = activeOffers
    .sort((a, b) => a.priority - b.priority)
    .map((offer) => {
      const conditions = conditionRows.filter((c) => c.offerId === offer.id);
      const rewards = rewardRows.filter((r) => r.offerId === offer.id);
      const policy = policyRows.find((p) => p.offerId === offer.id) ?? null;
      return {
        offer: compileOfferConfig(
          offer,
          conditions,
          rewards,
          policy,
          computeOfferVersion(offer, conditions, rewards, policy),
        ),
        shippingOffers: compileShippingOfferConfigs(offer, conditions, rewards),
      };
    });

  const compiledOffers = await resolveLegacyGiftVariants(
    shopId,
    compiledByOffer.map((entry) => entry.offer),
  );
  const shippingOffers = compiledByOffer.flatMap((entry) => entry.shippingOffers);

  const config: CompiledFunctionConfig = {
    offers: compiledOffers,
    shippingOffers,
    version: "1",
    compiledAt: new Date().toISOString(),
    ...buildAttributeQueryVariables(conditionRows),
  };

  const sizeBytes = estimateConfigSize(config);
  if (sizeBytes > MAX_METAFIELD_BYTES) {
    throw new Error(`Function config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit. Pause or simplify active offers before publishing.`);
  }

  await Promise.all([
    pushMetafield(shopDomain, accessToken, discountId, config),
    syncCartValidation(shopDomain, accessToken, buildCartValidationConfig(compiledOffers)),
    syncDiscountCombinationPolicy(
      shopDomain,
      accessToken,
      discountId,
      compileDiscountCombinationPolicy(compiledOffers),
    ),
  ]);

  for (const compiledOffer of compiledOffers) {
    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer })
      .where(eq(offers.id, compiledOffer.id));
  }
}

/**
 * Older offers could store only a product GID. Resolve those targets to the
 * current eligible variants before publishing so checkout never has to trust
 * a broad product-level allowance.
 */
async function resolveLegacyGiftVariants(
  shopId: string,
  compiledOffers: CompiledFunctionConfig["offers"],
): Promise<CompiledFunctionConfig["offers"]> {
  const unresolvedProductIds = [...new Set(compiledOffers.flatMap((offer) =>
    offer.giftRewards
      .filter((reward) => reward.targetVariantIds.length === 0)
      .flatMap((reward) => reward.targetProductIds),
  ))];
  if (unresolvedProductIds.length === 0) return compiledOffers;

  const variants = await getDb()
    .select({
      productGid: variantCache.productGid,
      variantGid: variantCache.variantGid,
      availableForSale: variantCache.availableForSale,
      inventoryQuantity: variantCache.inventoryQuantity,
      inventoryPolicy: variantCache.inventoryPolicy,
      requiresSellingPlan: variantCache.requiresSellingPlan,
    })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.productGid, unresolvedProductIds)));
  const eligibleByProduct = new Map<string, string[]>();
  for (const variant of variants) {
    if (
      !variant.availableForSale ||
      variant.requiresSellingPlan ||
      (variant.inventoryPolicy !== "CONTINUE" && (variant.inventoryQuantity ?? 0) <= 0)
    ) continue;
    const ids = eligibleByProduct.get(variant.productGid) ?? [];
    ids.push(variant.variantGid);
    eligibleByProduct.set(variant.productGid, ids);
  }

  return compiledOffers.map((offer) => {
    const giftRewards = offer.giftRewards.map((reward) => {
      if (reward.targetVariantIds.length > 0) return reward;
      const targetVariantIds = [...new Set(reward.targetProductIds.flatMap(
        (productId) => eligibleByProduct.get(productId) ?? [],
      ))].sort();
      if (targetVariantIds.length === 0) {
        throw new Error(
          `Gift reward ${reward.id} in offer ${offer.id} has no eligible one-time-purchase variants. Refresh the product catalog or update the reward before publishing.`,
        );
      }
      return { ...reward, targetVariantIds };
    });
    return {
      ...offer,
      giftRewards,
      giftVariantIds: [...new Set(giftRewards.flatMap((reward) => reward.targetVariantIds))],
    };
  });
}

async function pushMetafield(
  shopDomain: string,
  accessToken: string,
  ownerId: string,
  config: CompiledFunctionConfig,
): Promise<void> {
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
