import {
  variantCache,
  type Db,
  type Offer,
  type OfferCombinationPolicy,
  type OfferCondition,
  type OfferReward,
} from "@promo/db";
import { and, eq, inArray } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { offerCompileError } from "../offer-publish-errors.server.js";
import { computeOfferVersion } from "../offer-version.server.js";
import {
  compileOfferConfig,
  compileShippingOfferConfigs,
  type CompiledFunctionConfig,
  type CompiledOffer,
  type CompiledShippingOffer,
} from "./compile-config.js";

/** Offers with an enabled legacy `discount_code` condition: no Function can enforce it, so they are never published. */
export function legacyGatedOfferIds(conditions: readonly Pick<OfferCondition, "offerId" | "conditionType" | "isEnabled">[]): Set<string> {
  return new Set(conditions.filter((row) => row.conditionType === "discount_code" && row.isEnabled).map((row) => row.offerId));
}

/** Who compiles: tags the logs and Sentry events of a skipped gift reward. */
export type CartOffersCaller = "offer-publisher" | "capacity-preflight" | "mcp-preview";

export interface CartOfferEntry {
  source: Offer;
  offer: CompiledOffer;
  shipping: CompiledShippingOffer[];
}

/**
 * Compiles the shared automatic offers exactly as the publisher pushes them (real version, limits, resolved gift
 * variants), in priority order. The capacity preflight calls it too, so both plan the same bytes.
 */
export async function compileCartOffers(
  db: Db,
  shopId: string,
  offers: readonly Offer[],
  input: {
    conditions: readonly OfferCondition[];
    /** Rows the version hashes; the publisher compiles market conditions resolved to countries but versions the stored rows. */
    versionConditions?: readonly OfferCondition[];
    rewards: readonly OfferReward[];
    policies: readonly OfferCombinationPolicy[];
    shopCurrencyCode: string;
    limitsEnforced: boolean;
    caller: CartOffersCaller;
  },
): Promise<CartOfferEntry[]> {
  const { shopCurrencyCode, limitsEnforced } = input;
  const versionConditions = input.versionConditions ?? input.conditions;
  const entries = [...offers]
    .sort((a, b) => a.priority - b.priority)
    .map((offer) => {
      const conditions = input.conditions.filter((c) => c.offerId === offer.id);
      const rewards = input.rewards.filter((r) => r.offerId === offer.id);
      const policy = input.policies.find((p) => p.offerId === offer.id) ?? null;
      const version = computeOfferVersion(offer, versionConditions.filter((c) => c.offerId === offer.id), rewards, policy);
      try {
        return {
          source: offer,
          offer: compileOfferConfig(offer, conditions, rewards, policy, version, { shopCurrencyCode, limitsEnforced }),
          shipping: compileShippingOfferConfigs(offer, conditions, rewards, { shopCurrencyCode, limitsEnforced, policy }),
        };
      } catch (error) {
        throw offerCompileError(offer, error);
      }
    });
  const resolved = await resolveLegacyGiftVariants(db, shopId, entries.map((entry) => entry.offer), input.caller);
  return entries.map((entry, index) => ({ ...entry, offer: resolved[index]! }));
}

/**
 * Older offers could store only a product GID. Resolve those targets to the
 * current eligible variants before publishing so checkout never has to trust
 * a broad product-level allowance.
 */
export async function resolveLegacyGiftVariants(
  db: Db,
  shopId: string,
  compiledOffers: CompiledFunctionConfig["offers"],
  caller: CartOffersCaller,
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

  const variants = await db
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
    // Sold-out variants stay in the gift (storefront shows them sold out until restocked);
    // only subscription-only variants can't be granted.
    if (variant.requiresSellingPlan) continue;
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
          `[${caller}] Skipping gift reward ${reward.id} in offer ${offer.id}: no eligible one-time-purchase variants.`,
        );
        // An MCP preview is read-only: it must not page anyone about a reward the real publish would also report.
        if (caller !== "mcp-preview") {
          Sentry.captureMessage("Gift reward skipped: no eligible variants", {
            level: "warning",
            tags: { offerId: offer.id, rewardId: reward.id, caller },
          });
        }
        return [];
      }
      return [{ ...reward, targetVariantIds }];
    });
    return [
      {
        ...offer,
        giftRewards,
        giftVariantIds: [...new Set(giftRewards.flatMap((reward) => reward.targetVariantIds))],
      },
    ];
  });
}
