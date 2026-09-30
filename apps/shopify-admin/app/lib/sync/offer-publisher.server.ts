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
import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { decryptToken } from "../token-crypto.server.js";
import { shopifyGraphQL } from "../shopify-fetch.server.js";
import {
  CART_DISCOUNT_CLASSES,
  DELIVERY_DISCOUNT_CLASSES,
  createOrFindCodeDiscount,
  discountNodeExists,
  ensureDiscountNodes,
  findCartDiscountFunction,
  syncDiscountCombinationPolicy,
  updateCodeDiscountCombination,
  type ShopifyFunctionSummary,
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
  const allActiveOffers: Offer[] = (await isShadowModeEnabled(shopId))
    ? []
    : await db
        .select()
        .from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

  // Offers with a required checkout code get their own dedicated
  // discountCodeAppCreate node + single-offer config instead of riding along
  // in the shared automatic discount config every other offer type uses.
  const codeOffers = allActiveOffers.filter((offer) => Boolean(offer.requiredDiscountCode));
  const regularOffers = allActiveOffers.filter((offer) => !offer.requiredDiscountCode);

  // Deactivate any offer whose codeDiscountId is still set but is no longer
  // part of the active code-offer set — run this FIRST and unconditionally,
  // before anything below (compiling, pushing) gets a chance to throw and
  // skip it. A merchant pausing/archiving a code-gated offer must stop
  // honoring its checkout code even if some other offer's publish fails.
  await neutralizeStaleCodeOffers(shopId, shopDomain, accessToken, codeOffers);

  // Compile every active code offer's config now (this also ensures each
  // one's dedicated discount node exists) so their conditions/rewards can be
  // folded into the SAME cart-validation config as regular offers below —
  // otherwise a gift or product-discount reward on a code-gated offer fails
  // cart validation as if no offer had authorized it, since validation only
  // ever saw the shared automatic-discount offers.
  const compiledCodeOffers = await compileCodeOffers(shopId, shopDomain, accessToken, codeOffers);
  const codeOfferConfigs = compiledCodeOffers.map((entry) => entry.compiledOffer);

  if (regularOffers.length === 0) {
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
    await syncCartValidation(shopDomain, accessToken, buildCartValidationConfig(codeOfferConfigs));
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
  } else {
    const regularOfferIds = regularOffers.map((offer) => offer.id);
    const [conditionRows, rewardRows, policyRows]: [
      OfferCondition[],
      OfferReward[],
      OfferCombinationPolicy[],
    ] = await Promise.all([
      db
        .select()
        .from(offerConditions)
        .where(
          and(
            eq(offerConditions.shopId, shopId),
            inArray(offerConditions.offerId, regularOfferIds),
          ),
        ),
      db
        .select()
        .from(offerRewards)
        .where(
          and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, regularOfferIds)),
        ),
      db
        .select()
        .from(offerCombinationPolicies)
        .where(
          and(
            eq(offerCombinationPolicies.shopId, shopId),
            inArray(offerCombinationPolicies.offerId, regularOfferIds),
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

    const compiledByOffer = regularOffers
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
    // be granted with incomplete validation or combination rules. Cart
    // validation must see code offers too — they authorize gift/product/order
    // rewards exactly like a regular offer, just through a different discount
    // node, and validation has no other way to know they're allowed.
    await syncCartValidation(
      shopDomain,
      accessToken,
      buildCartValidationConfig([...compiledOffers, ...codeOfferConfigs]),
    );
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

  // Now that cart validation and the shared automatic config are live, push
  // each code offer's own guardrails-then-config to its dedicated node.
  await pushCodeOfferConfigs(shopId, shopDomain, accessToken, compiledCodeOffers);
}

interface CompiledCodeOffer {
  offer: Offer;
  discountId: string;
  compiledOffer: CompiledFunctionConfig["offers"][number];
  conditionRows: OfferCondition[];
}

/**
 * Ensures each active code-gated offer has its own `discountCodeAppCreate`
 * node (creating and persisting one if needed) and compiles its config —
 * but does NOT push anything to Shopify yet. Split out from the actual push
 * so the compiled result can be folded into the shop-wide cart-validation
 * config (see caller) before any discount config goes live.
 */
async function compileCodeOffers(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  codeOffers: Offer[],
): Promise<CompiledCodeOffer[]> {
  const db = getDb();
  let cartFunction: ShopifyFunctionSummary | null = null;
  const results: CompiledCodeOffer[] = [];

  for (const offer of codeOffers) {
    const code = offer.requiredDiscountCode;
    if (!code) continue; // Unreachable — codeOffers is pre-filtered — but keeps TS narrowed.

    let discountId = offer.codeDiscountId;
    if (discountId && !(await discountNodeExists(shopDomain, accessToken, discountId))) {
      discountId = null;
    }
    if (!discountId) {
      cartFunction ??= await findCartDiscountFunction(shopDomain, accessToken);
      discountId = await createOrFindCodeDiscount(
        shopDomain,
        accessToken,
        cartFunction,
        code,
        offer.internalName || offer.publicTitle,
        CART_DISCOUNT_CLASSES,
      );
      await db
        .update(offers)
        .set({ codeDiscountId: discountId, updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offer.id)));
    }

    const [conditionRows, rewardRows, policyRows]: [
      OfferCondition[],
      OfferReward[],
      OfferCombinationPolicy[],
    ] = await Promise.all([
      db
        .select()
        .from(offerConditions)
        .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offer.id))),
      db
        .select()
        .from(offerRewards)
        .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offer.id))),
      db
        .select()
        .from(offerCombinationPolicies)
        .where(
          and(
            eq(offerCombinationPolicies.shopId, shopId),
            eq(offerCombinationPolicies.offerId, offer.id),
          ),
        ),
    ]);
    const policy = policyRows[0] ?? null;

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

    const compiledOffer = compileOfferConfig(
      offer,
      functionConditionRows,
      rewardRows,
      policy,
      computeOfferVersion(offer, conditionRows, rewardRows, policy),
    );
    const [resolvedOffer] = await resolveLegacyGiftVariants(shopId, [compiledOffer]);
    const finalCompiledOffer = resolvedOffer ?? compiledOffer;

    results.push({ offer, discountId, compiledOffer: finalCompiledOffer, conditionRows });
  }

  return results;
}

/**
 * Pushes each already-compiled code offer's guardrails (combination policy)
 * then its single-offer config to its dedicated node — guardrails before
 * config, matching the shared path's "stop discount generation only after
 * validation/combination are safe" ordering.
 */
async function pushCodeOfferConfigs(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  compiledCodeOffers: CompiledCodeOffer[],
): Promise<void> {
  const db = getDb();

  for (const { offer, discountId, compiledOffer, conditionRows } of compiledCodeOffers) {
    const customerTags = [
      ...new Set([
        ...(compiledOffer.requiredCustomerTags ?? []),
        ...(compiledOffer.excludedCustomerTags ?? []),
      ]),
    ].sort();

    // A code discount only ever references the cart-lines Function — a
    // code-gated offer's shipping rewards (if any) aren't enforced through
    // this path, matching the shared path's split between the cart and
    // delivery Functions. customerTags/query-variables must still be set
    // here exactly as the shared config sets them, or a customer-tag or
    // cart-attribute condition on this offer silently never matches — the
    // Function reads those off this same config, not the shared one.
    const singleOfferConfig: CompiledFunctionConfig = {
      offers: [compiledOffer],
      shippingOffers: [],
      version: "1",
      compiledAt: new Date().toISOString(),
      ...(customerTags.length > 0 ? { customerTags } : {}),
      ...buildAttributeQueryVariables(conditionRows),
    };
    const value = serializeFunctionConfig(singleOfferConfig);
    const sizeBytes = new TextEncoder().encode(value).byteLength;
    if (sizeBytes > MAX_METAFIELD_BYTES) {
      throw new Error(
        `Code offer "${offer.internalName}" config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit.`,
      );
    }

    await updateCodeDiscountCombination(
      shopDomain,
      accessToken,
      discountId,
      compileDiscountCombinationPolicy([compiledOffer]),
      CART_DISCOUNT_CLASSES,
    );
    await pushMetafields(shopDomain, accessToken, [discountId], value);

    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer })
      .where(and(eq(offers.shopId, shopId), eq(offers.id, offer.id)));
  }
}

/**
 * Empties the compiled config on any offer whose `codeDiscountId` is still
 * set but that isn't part of the currently active code-offer set. The
 * discount node itself (and its real Shopify checkout code) stays — only
 * the Function config it serves is cleared, the same "stop discount
 * generation" pattern the shared automatic path uses for zero active
 * offers.
 *
 * Guards against a stale row sharing its `codeDiscountId` with a CURRENTLY
 * active code offer (e.g. an archived offer's code got reused and, due to
 * Shopify's duplicate-code recovery, the new offer resolved to the SAME
 * discount node) — excluded by discount id, not just by offer id, or the
 * active offer's just-pushed config would get immediately wiped out here.
 */
async function neutralizeStaleCodeOffers(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  activeCodeOffers: Offer[],
): Promise<void> {
  const db = getDb();
  const trackedCodeOffers = await db
    .select({ id: offers.id, codeDiscountId: offers.codeDiscountId })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), isNotNull(offers.codeDiscountId)));

  const activeIds = new Set(activeCodeOffers.map((offer) => offer.id));
  const activeDiscountIds = new Set(
    activeCodeOffers.map((offer) => offer.codeDiscountId).filter((id): id is string => Boolean(id)),
  );
  const staleDiscountIds = trackedCodeOffers
    .filter(
      (offer) =>
        !activeIds.has(offer.id) &&
        offer.codeDiscountId &&
        !activeDiscountIds.has(offer.codeDiscountId),
    )
    .map((offer) => offer.codeDiscountId as string);
  if (staleDiscountIds.length === 0) return;

  const emptyConfig: CompiledFunctionConfig = {
    offers: [],
    shippingOffers: [],
    version: "1",
    compiledAt: new Date().toISOString(),
  };
  const emptyValue = serializeFunctionConfig(emptyConfig);
  for (const discountId of staleDiscountIds) {
    await pushMetafields(shopDomain, accessToken, [discountId], emptyValue);
  }
}

/**
 * Empties a single code-gated offer's discount node directly, by id — used
 * when hard-deleting an offer. `neutralizeStaleCodeOffers` (run on every
 * regular publish) only ever looks at offers still present in the `offers`
 * table, so deleting the row first would make a code-gated offer invisible
 * to it forever, leaving its real, live Shopify discount code enterable at
 * checkout indefinitely with whatever config it last had.
 */
export async function neutralizeCodeDiscountNode(
  shopId: string,
  shopDomain: string,
  discountId: string,
): Promise<void> {
  const db = getDb();
  const [shopRow] = await db
    .select({ accessTokenEncrypted: shops.accessTokenEncrypted })
    .from(shops)
    .where(
      and(eq(shops.id, shopId), eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)),
    )
    .limit(1);
  if (!shopRow) return;
  const accessToken = await decryptToken(shopRow.accessTokenEncrypted);

  const emptyConfig: CompiledFunctionConfig = {
    offers: [],
    shippingOffers: [],
    version: "1",
    compiledAt: new Date().toISOString(),
  };
  await pushMetafields(shopDomain, accessToken, [discountId], serializeFunctionConfig(emptyConfig));
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
