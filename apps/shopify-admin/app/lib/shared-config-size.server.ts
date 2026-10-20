import { and, eq, inArray, or } from "drizzle-orm";
import {
  discountCodes,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  shops,
  type Db,
} from "@promo/db";
import { compileOfferConfig, compileShippingOfferConfigs, serializeFunctionConfig } from "./sync/compile-config.js";
import { buildAttributeQueryVariables } from "./sync/attribute-query-variables.js";
import { isCheckoutCodeGated } from "./code-redemption.js";
import { MAX_METAFIELD_BYTES } from "./sync/offer-publisher.server.js";
import { buildCartValidationConfig, MAX_VALIDATION_CONFIG_BYTES } from "./cart-validation.server.js";
import { OfferPublishError, offerCompileError } from "./offer-publish-errors.server.js";

const encodedBytes = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * Compiles the shared automatic config as the publisher would build it if `includeOfferIds` ran
 * through it alongside every active non-code offer (`forceInclude`: even a code-gated one, for an
 * offer about to switch to automatic). Approximation: skips market-to-country resolution.
 */
async function compileSharedOffers(
  db: Db,
  shopId: string,
  shopCurrencyCode: string,
  includeOfferIds: string[],
  forceInclude: boolean,
) {
  const rows = await db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.shopId, shopId),
        includeOfferIds.length > 0
          ? or(eq(offers.status, "active"), inArray(offers.id, includeOfferIds))
          : eq(offers.status, "active"),
      ),
    );
  if (rows.length === 0) return null;
  const ids = rows.map((offer) => offer.id);
  const [codeRows, conditions, rewards, policies] = await Promise.all([
    db.select({ offerId: discountCodes.offerId }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.offerId, ids))),
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, ids))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, ids))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, ids))),
  ]);
  const withCodes = new Set(codeRows.map((row) => row.offerId));
  const extra = new Set(forceInclude ? includeOfferIds : []);
  const shared = rows
    .filter((offer) => extra.has(offer.id) || !isCheckoutCodeGated(offer, withCodes.has(offer.id)))
    .sort((a, b) => a.priority - b.priority);
  const compiled = shared.map((offer) => {
    const offerConditionsRows = conditions.filter((c) => c.offerId === offer.id);
    const offerRewardsRows = rewards.filter((r) => r.offerId === offer.id);
    const policy = policies.find((p) => p.offerId === offer.id) ?? null;
    try {
      return {
        offer: compileOfferConfig(offer, offerConditionsRows, offerRewardsRows, policy, 1, { shopCurrencyCode }),
        shipping: compileShippingOfferConfigs(offer, offerConditionsRows, offerRewardsRows, { shopCurrencyCode }),
        conditions: offerConditionsRows,
        name: offer.internalName,
      };
    } catch (error) {
      throw offerCompileError(offer, error);
    }
  });
  return {
    compiled,
    config: (extraFields: Record<string, string> = {}) =>
      serializeFunctionConfig({
        offers: compiled.map((entry) => entry.offer),
        shippingOffers: compiled.flatMap((entry) => entry.shipping),
        version: "1",
        compiledAt: "2026-01-01T00:00:00.000Z",
        ...extraFields,
      }),
  };
}

/** Bytes of the shared automatic config if `includeOfferIds` switched to automatic. */
export async function estimateSharedConfigBytes(
  db: Db,
  shopId: string,
  shopCurrencyCode: string,
  includeOfferIds: string[],
): Promise<number> {
  const shared = await compileSharedOffers(db, shopId, shopCurrencyCode, includeOfferIds, true);
  return shared ? encodedBytes(shared.config()) : 0;
}

export interface PreflightFailure {
  error: string;
  /** Set when one offer's own data is at fault, not the shop-wide limits. */
  offerId?: string;
}

/**
 * Checks the shop config the publisher would build with `offerIds` active (compile, cart-attribute
 * keys, shared config and cart-validation size) before any status is written.
 */
export async function preflightSharedConfig(
  db: Db,
  shopId: string,
  offerIds: string[],
): Promise<PreflightFailure | null> {
  const [shop] = await db.select({ currencyCode: shops.currencyCode }).from(shops).where(eq(shops.id, shopId));
  let shared;
  try {
    shared = await compileSharedOffers(db, shopId, shop?.currencyCode ?? "USD", offerIds, false);
  } catch (error) {
    if (error instanceof OfferPublishError) return { error: error.message, offerId: error.offerId };
    throw error;
  }
  if (!shared) return null;

  const conditions = shared.compiled.flatMap((entry) => entry.conditions);
  let attributeVariables: Record<string, string>;
  try {
    attributeVariables = buildAttributeQueryVariables(conditions);
  } catch (error) {
    const users = shared.compiled
      .filter((entry) => entry.conditions.some((c) => c.isEnabled && c.conditionType === "cart_attribute"))
      .map((entry) => `"${entry.name}"`);
    return { error: `${(error as Error).message} Offers using them: ${users.join(", ")}.` };
  }

  const bytes = encodedBytes(shared.config(attributeVariables));
  if (bytes > MAX_METAFIELD_BYTES) return { error: sharedConfigTooLargeMessage(bytes) };

  const validationBytes = encodedBytes(
    JSON.stringify(buildCartValidationConfig(shared.compiled.map((entry) => entry.offer))),
  );
  if (validationBytes > MAX_VALIDATION_CONFIG_BYTES) {
    return {
      error: `The cart validation config would be ${validationBytes}B, over the ${MAX_VALIDATION_CONFIG_BYTES}B limit. Pause or simplify active gift offers first.`,
    };
  }
  return null;
}

export function sharedConfigTooLargeMessage(bytes: number): string {
  return `The shared automatic config would be ${bytes}B, over the ${MAX_METAFIELD_BYTES}B limit. Pause or simplify other automatic offers first.`;
}
