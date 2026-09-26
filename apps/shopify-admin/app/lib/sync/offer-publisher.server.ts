import {
  getDb,
  shops,
  offers,
  offerConditions,
  offerRewards,
  offerCombinationPolicies,
  variantCache,
  type Offer,
  type OfferCondition,
  type OfferReward,
  type OfferCombinationPolicy,
} from "@promo/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { decryptToken } from "../token-crypto.server.js";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import {
  CART_DISCOUNT_CLASSES,
  DELIVERY_DISCOUNT_CLASSES,
  ensureDiscountNodes,
  syncDiscountCombinationPolicy,
} from "../discount-node.server.js";
import { buildCartValidationConfig, syncCartValidation } from "../cart-validation.server.js";
import { computeOfferVersion } from "../offer-version.server.js";
import {
  compileOfferConfig,
  compileDiscountCombinationPolicy,
  compileShippingOfferConfigs,
  serializeFunctionConfig,
  type CompiledFunctionConfig,
} from "./compile-config.js";
import { buildAttributeQueryVariables } from "./attribute-query-variables.js";
import { isShadowModeEnabled } from "../shadow-mode.server.js";
import { syncMarketsForShop } from "./market-sync.server.js";
import { resolveMarketConditionsToCountries } from "./market-condition-resolution.server.js";

const METAFIELD_NAMESPACE = "promo_engine";
const METAFIELD_KEY = "function_config";
const MAX_METAFIELD_BYTES = 9500;

/**
 * Concurrent publishes for the same shop (e.g. a cron reconciliation run
 * overlapping a merchant save) must not interleave: each does read-compile-push
 * as one unit, so a per-shop advisory lock serializes them. It is
 * transaction-scoped on purpose: behind Neon's transaction-mode pooler a
 * session lock and its unlock can land on different server connections, which
 * leaked the lock and hung every later publish for the shop. An xact lock is
 * pinned to the transaction's backend and released on commit, rollback or
 * disconnect.
 */
export async function publishOffersForShop(shopId: string, shopDomain: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '60s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${shopId}))`);
    await publishOffersForShopLocked(shopId, shopDomain);
  });
}

async function publishOffersForShopLocked(shopId: string, shopDomain: string): Promise<void> {
  // Re-read everything after acquiring the lock — a concurrent publish that
  // held the lock before us may have changed offers/discount nodes.
  const db = getDb();

  const [shopRow] = await db
    .select({ accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(
      and(eq(shops.id, shopId), eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)),
    )
    .limit(1);

  if (!shopRow) {
    throw new Error(
      "Cannot publish offers: active shop identity does not match the requested shop.",
    );
  }

  const accessToken = await decryptToken(shopRow.accessTokenEncrypted);
  // Self-heals if afterAuth's registration failed or hasn't run yet (e.g. the
  // function was deployed after this shop installed the app).
  const discountNodes = await ensureDiscountNodes(shopId, shopDomain, accessToken);
  const discountNodesWithClasses = [
    { discountId: discountNodes.cartLinesDiscountId, discountClasses: CART_DISCOUNT_CLASSES },
    { discountId: discountNodes.deliveryDiscountId, discountClasses: DELIVERY_DISCOUNT_CLASSES },
  ];
  const discountIds = discountNodesWithClasses.map(({ discountId }) => discountId);

  // Shadow mode runs in parallel with BOGOS: publishing live config would double-discount.
  const activeOffers: Offer[] = (await isShadowModeEnabled(shopId))
    ? []
    : await db
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
    // Stop discount generation first. The remaining writes only loosen/remove
    // validation and combination state, so a later failure cannot grant an
    // offer that was meant to be disabled.
    await pushMetafields(
      shopDomain,
      accessToken,
      discountIds,
      serializeFunctionConfig(emptyConfig),
    );
    await syncCartValidation(shopDomain, accessToken, buildCartValidationConfig([]));
    await Promise.all(
      discountNodesWithClasses.map(({ discountId, discountClasses }) =>
        syncDiscountCombinationPolicy(
          shopDomain,
          accessToken,
          discountId,
          compileDiscountCombinationPolicy([]),
          discountClasses,
        ),
      ),
    );
    return;
  }

  const activeOfferIds = activeOffers.map((offer) => offer.id);
  const [conditionRows, rewardRows, policyRows]: [
    OfferCondition[],
    OfferReward[],
    OfferCombinationPolicy[],
  ] = await Promise.all([
    db
      .select()
      .from(offerConditions)
      .where(
        and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, activeOfferIds)),
      ),
    db
      .select()
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, activeOfferIds))),
    db
      .select()
      .from(offerCombinationPolicies)
      .where(
        and(
          eq(offerCombinationPolicies.shopId, shopId),
          inArray(offerCombinationPolicies.offerId, activeOfferIds),
        ),
      ),
  ]);

  const hasMarketConditions = conditionRows.some(
    (condition) =>
      condition.isEnabled &&
      (condition.scope === "main" || condition.scope === "sub") &&
      condition.conditionType === "markets",
  );
  const functionConditionRows = hasMarketConditions
    ? resolveMarketConditionsToCountries(
        conditionRows,
        await syncMarketsForShop(shopId, shopDomain, accessToken),
      )
    : conditionRows;

  const compiledByOffer = activeOffers
    .sort((a, b) => a.priority - b.priority)
    .map((offer) => {
      const conditions = functionConditionRows.filter((c) => c.offerId === offer.id);
      const versionConditions = conditionRows.filter((c) => c.offerId === offer.id);
      const rewards = rewardRows.filter((r) => r.offerId === offer.id);
      const policy = policyRows.find((p) => p.offerId === offer.id) ?? null;
      return {
        offer: compileOfferConfig(
          offer,
          conditions,
          rewards,
          policy,
          computeOfferVersion(offer, versionConditions, rewards, policy),
        ),
        shippingOffers: compileShippingOfferConfigs(offer, conditions, rewards),
      };
    });

  const compiledOffers = await resolveLegacyGiftVariants(
    shopId,
    compiledByOffer.map((entry) => entry.offer),
  );
  const shippingOffers = compiledByOffer.flatMap((entry) => entry.shippingOffers);
  const customerTags = [
    ...new Set(
      compiledOffers.flatMap((offer) => [
        ...(offer.requiredCustomerTags ?? []),
        ...(offer.excludedCustomerTags ?? []),
      ]),
    ),
  ].sort();
  if (customerTags.length > 100) {
    throw new Error(
      "Active offers reference more than 100 unique customer tags. Reduce the tag set before publishing.",
    );
  }

  const config: CompiledFunctionConfig = {
    offers: compiledOffers,
    shippingOffers,
    version: "1",
    compiledAt: new Date().toISOString(),
    ...(customerTags.length > 0 ? { customerTags } : {}),
    ...buildAttributeQueryVariables(conditionRows),
  };

  const value = serializeFunctionConfig(config);
  const sizeBytes = new TextEncoder().encode(value).byteLength;
  if (sizeBytes > MAX_METAFIELD_BYTES) {
    throw new Error(
      `Function config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit. Pause or simplify active offers before publishing.`,
    );
  }

  // Publish guardrails before the discount config. If either prerequisite
  // fails, the previous Function config stays active and the new offer cannot
  // be granted with incomplete validation or combination rules.
  await syncCartValidation(shopDomain, accessToken, buildCartValidationConfig(compiledOffers));
  await Promise.all(
    discountNodesWithClasses.map(({ discountId, discountClasses }) =>
      syncDiscountCombinationPolicy(
        shopDomain,
        accessToken,
        discountId,
        compileDiscountCombinationPolicy(compiledOffers),
        discountClasses,
      ),
    ),
  );
  await pushMetafields(shopDomain, accessToken, discountIds, value);

  for (const compiledOffer of compiledOffers) {
    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer })
      .where(and(eq(offers.shopId, shopId), eq(offers.id, compiledOffer.id)));
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
  const unresolvedProductIds = [
    ...new Set(
      compiledOffers.flatMap((offer) =>
        offer.giftRewards
          .filter((reward) => reward.targetVariantIds.length === 0)
          .flatMap((reward) => reward.targetProductIds),
      ),
    ),
  ];
  if (unresolvedProductIds.length === 0) return compiledOffers;

  const variants = await getDb()
    .select({
      productGid: variantCache.productGid,
      variantGid: variantCache.variantGid,
      availableForSale: variantCache.availableForSale,
      requiresSellingPlan: variantCache.requiresSellingPlan,
    })
    .from(variantCache)
    .where(
      and(eq(variantCache.shopId, shopId), inArray(variantCache.productGid, unresolvedProductIds)),
    );
  const eligibleByProduct = new Map<string, string[]>();
  for (const variant of variants) {
    // availableForSale already accounts for untracked inventory and "continue
    // selling when out of stock" — a raw qty of 0 + DENY can still be sellable.
    if (!variant.availableForSale || variant.requiresSellingPlan) continue;
    const ids = eligibleByProduct.get(variant.productGid) ?? [];
    ids.push(variant.variantGid);
    eligibleByProduct.set(variant.productGid, ids);
  }

  return compiledOffers.flatMap((offer) => {
    const giftRewards = offer.giftRewards.flatMap((reward) => {
      if (reward.targetVariantIds.length > 0) return [reward];
      const targetVariantIds = [
        ...new Set(
          reward.targetProductIds.flatMap((productId) => eligibleByProduct.get(productId) ?? []),
        ),
      ].sort();
      if (targetVariantIds.length === 0) {
        // Don't fail the whole shop's publish over one stale reward — skip it
        // and keep publishing every other offer/reward that's still valid.
        console.error(
          `[offer-publisher] Skipping gift reward ${reward.id} in offer ${offer.id}: no eligible one-time-purchase variants.`,
        );
        Sentry.captureMessage("Gift reward skipped: no eligible variants", {
          level: "warning",
          tags: { offerId: offer.id, rewardId: reward.id },
        });
        return [];
      }
      return [{ ...reward, targetVariantIds }];
    });
    return [{
      ...offer,
      giftRewards,
      giftVariantIds: [...new Set(giftRewards.flatMap((reward) => reward.targetVariantIds))],
    }];
  });
}

async function pushMetafields(
  shopDomain: string,
  accessToken: string,
  ownerIds: string[],
  value: string,
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
      metafields: [...new Set(ownerIds)].map((ownerId) => ({
        ownerId,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value,
      })),
    },
  });

  const errors = data.metafieldsSet.userErrors;
  if (errors.length > 0)
    throw new Error(`Metafield errors: ${errors.map((e) => e.message).join(", ")}`);
}
