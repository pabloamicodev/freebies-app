import {
  getDb,
  shops,
  offers,
  offerConditions,
  offerRewards,
  offerCombinationPolicies,
  variantCache,
  discountCodes,
  discountCodeBatches,
  type DiscountCode,
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
  addRedeemCodes,
  createOrFindCodeDiscount,
  deleteCodeDiscountNode,
  ensureCodeDiscountNode,
  ensureDiscountNodes,
  expireCodeDiscountNode,
  findCodeDiscountNode,
  findCartDiscountFunction,
  findDeliveryDiscountFunction,
  getCodeDiscountFunctionId,
  removeRedeemCodes,
  syncDiscountCombinationPolicy,
  updateCodeDiscountCombination,
  type CodeDiscountNodeOptions,
  type ShopifyFunctionSummary,
} from "../discount-node.server.js";
import { isCodeRedeemable } from "../discount-code-generation.js";
import { codeHash } from "../code-hash.js";
import { resolveCodeCollisions } from "../code-preflight.server.js";
import type { CodeCharset } from "../discount-code-generation.js";
import { isCodeBackendBEnabled } from "../code-backend.server.js";
import { buildCartValidationConfig, syncCartValidation } from "../cart-validation.server.js";
import { computeOfferVersion } from "../offer-version.server.js";
import {
  compileOfferConfig,
  compileDiscountCombinationPolicy,
  compileShippingOfferConfigs,
  serializeFunctionConfig,
  type CompiledFunctionConfig,
  type CompiledShippingOffer,
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
  const activeOffersRaw: Offer[] = (await isShadowModeEnabled(shopId))
    ? []
    : await db
        .select()
        .from(offers)
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

  // Legacy `discount_code` conditions can't be enforced by any Function. Such an
  // offer is held back (never published ungated) instead of failing the whole
  // shop's publish; the discount-code migration moves it onto the Codes tab.
  const legacyGateRows =
    activeOffersRaw.length === 0
      ? []
      : await db
          .select({
            offerId: offerConditions.offerId,
            conditionType: offerConditions.conditionType,
            isEnabled: offerConditions.isEnabled,
          })
          .from(offerConditions)
          .where(
            and(
              eq(offerConditions.shopId, shopId),
              inArray(
                offerConditions.offerId,
                activeOffersRaw.map((offer) => offer.id),
              ),
            ),
          );
  const heldBackIds = new Set(
    legacyGateRows
      .filter((row) => row.conditionType === "discount_code" && row.isEnabled)
      .map((row) => row.offerId),
  );
  for (const offerId of heldBackIds) {
    console.error(
      `[offer-publisher] Holding back offer ${offerId}: it has a legacy discount_code condition.`,
    );
    Sentry.captureMessage("Offer held back: legacy discount_code condition", {
      level: "error",
      tags: { offerId, shopId },
    });
  }
  const allActiveOffers = activeOffersRaw.filter((offer) => !heldBackIds.has(offer.id));

  // Offers with our own discount codes (or a legacy required checkout code) get
  // a dedicated discountCodeAppCreate node + single-offer config instead of
  // riding along in the shared automatic discount config. An offer that owns
  // codes is code-gated even when none is redeemable right now: it must never
  // fall through to the shared config, where it would apply with no code.
  const codeRows: DiscountCode[] =
    allActiveOffers.length === 0
      ? []
      : await db
          .select()
          .from(discountCodes)
          .where(
            and(
              eq(discountCodes.shopId, shopId),
              inArray(
                discountCodes.offerId,
                allActiveOffers.map((offer) => offer.id),
              ),
            ),
          );
  const codesByOffer = new Map<string, DiscountCode[]>();
  for (const row of codeRows)
    codesByOffer.set(row.offerId, [...(codesByOffer.get(row.offerId) ?? []), row]);
  // requiresCode keeps an offer gated even when every code is gone (e.g. a duplicate
  // with no codes yet): it then publishes nothing instead of running without a code.
  const isCodeOffer = (offer: Offer) =>
    offer.requiresCode || codesByOffer.has(offer.id) || Boolean(offer.requiredDiscountCode);
  const allCodeOffers = allActiveOffers.filter(isCodeOffer);
  const regularOffers = allActiveOffers.filter((offer) => !isCodeOffer(offer));
  // Backend B (opt-in per shop) serves code offers from the code Function's own
  // automatic node; its old per-offer code nodes then fall out of the active set
  // below and get neutralized like any other stale code node.
  const useBackendB = allCodeOffers.length > 0 && (await isCodeBackendBEnabled(shopId));
  const codeOffers = useBackendB ? [] : allCodeOffers;
  const backendBOffers = useBackendB ? allCodeOffers : [];

  // Deactivate any offer whose codeDiscountId is still set but is no longer
  // part of the active code-offer set — run this FIRST and unconditionally,
  // before anything below (compiling, pushing) gets a chance to throw and
  // skip it. A merchant pausing/archiving a code-gated offer must stop
  // honoring its checkout code even if some other offer's publish fails.
  await neutralizeStaleCodeOffers(shopId, shopDomain, accessToken, codeOffers);
  // Pull deactivated/expired/exhausted codes off live nodes just as early.
  await retireInactiveCodes(shopId, shopDomain, accessToken, codeOffers, codesByOffer);

  // Compile every active code offer's config now (this also ensures each
  // one's dedicated discount node exists) so their conditions/rewards can be
  // folded into the SAME cart-validation config as regular offers below —
  // otherwise a gift or product-discount reward on a code-gated offer fails
  // cart validation as if no offer had authorized it, since validation only
  // ever saw the shared automatic-discount offers.
  const compiledCodeOffers = await compileCodeOffers(
    shopId,
    shopDomain,
    accessToken,
    codeOffers,
    codesByOffer,
  );
  const compiledBackendB = await compileBackendBOffers(
    shopId,
    shopDomain,
    accessToken,
    backendBOffers,
    codesByOffer,
  );
  const codeOfferConfigs = [
    ...compiledCodeOffers.map((entry) => entry.compiledOffer),
    ...compiledBackendB.map((entry) => entry.compiledOffer),
  ];
  // Shipping rewards of code offers that run on the cart-lines code node (and all of
  // backend B's) are gated inside the shared automatic delivery node: the delivery
  // Function applies them only while one of the offer's codes is entered. Exhausted
  // or deactivated codes drop out of the hashes on the next publish.
  const gatedShippingOffers = [
    ...compiledCodeOffers.flatMap((entry) => entry.gatedShippingOffers),
    ...compiledBackendB.flatMap((entry) => entry.gatedShippingOffers),
  ];

  if (regularOffers.length === 0) {
    const emptyConfig: CompiledFunctionConfig = {
      offers: [],
      shippingOffers: gatedShippingOffers,
      version: "1",
      compiledAt: new Date().toISOString(),
    };
    // Stop discount generation first. The remaining writes only loosen/remove
    // validation and combination state, so a later failure cannot grant an
    // offer that was meant to be disabled.
    const emptyValue = serializeFunctionConfig(emptyConfig);
    assertConfigFits(emptyValue);
    await pushMetafields(shopDomain, accessToken, discountIds, emptyValue);
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
      shippingOffers: [...shippingOffers, ...gatedShippingOffers],
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
  await pushBackendBConfig(shopId, shopDomain, accessToken, compiledBackendB);
}

type CodeNodeKind = "cart" | "delivery";

interface CompiledCodeOffer {
  offer: Offer;
  kind: CodeNodeKind;
  discountId: string;
  compiledOffer: CompiledFunctionConfig["offers"][number];
  shippingOffers: CompiledShippingOffer[];
  /** Shipping rewards of a mixed offer, gated on its codes, for the shared delivery config. */
  gatedShippingOffers: CompiledShippingOffer[];
  conditionRows: OfferCondition[];
  /** Codes live on the node right now (not yet pushed ones excluded). */
  redeemableCodes: DiscountCode[];
  pendingCodes: DiscountCode[];
  nodeOptions: CodeDiscountNodeOptions;
}

/** Prefix/length/charset of each generated batch, so a colliding generated code is replaced by one of the same shape. */
async function batchShapes(
  shopId: string,
  rows: DiscountCode[],
): Promise<(row: DiscountCode) => { prefix: string; length: number; charset: CodeCharset } | null> {
  const batchIds = [...new Set(rows.flatMap((row) => (row.batchId ? [row.batchId] : [])))];
  if (batchIds.length === 0) return () => null;
  const batches = await getDb()
    .select()
    .from(discountCodeBatches)
    .where(and(eq(discountCodeBatches.shopId, shopId), inArray(discountCodeBatches.id, batchIds)));
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  return (row) => {
    const batch = row.batchId ? byId.get(row.batchId) : undefined;
    return batch
      ? { prefix: batch.prefix, length: batch.length, charset: batch.charset as CodeCharset }
      : null;
  };
}

async function markCodesSynced(shopId: string, rows: DiscountCode[]): Promise<void> {
  if (rows.length === 0) return;
  const syncedAt = new Date();
  await getDb()
    .update(discountCodes)
    .set({ shopifySyncedAt: syncedAt })
    .where(
      and(
        eq(discountCodes.shopId, shopId),
        inArray(
          discountCodes.id,
          rows.map((row) => row.id),
        ),
      ),
    );
  for (const row of rows) row.shopifySyncedAt = syncedAt;
}

const codeNodeTitle = (offer: Offer) => `[Promo Engine] ${offer.internalName || offer.publicTitle}`;

/**
 * A code discount node runs exactly one Function. Shipping rewards run through
 * the delivery Function, everything else through the cart-lines one, so a code
 * offer is bound to whichever its rewards need (publish validation rejects
 * offers that mix the two).
 */
function codeNodeKind(rewardRows: OfferReward[]): CodeNodeKind {
  // Shipping-only: the code node itself runs the delivery Function, so Shopify accepts
  // the code exactly when the shipping discount applies. A mixed offer keeps its
  // product/order part on a cart-lines code node and gates shipping in the shared
  // delivery node instead (see gatedShippingOffers).
  return rewardRows.length > 0 &&
    rewardRows.every((reward) => reward.rewardType === "shipping_discount")
    ? "delivery"
    : "cart";
}

function assertConfigFits(value: string): void {
  const sizeBytes = new TextEncoder().encode(value).byteLength;
  if (sizeBytes > MAX_METAFIELD_BYTES) {
    throw new Error(
      `Function config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit. Pause or simplify active offers (code offers with shipping rewards put their code hashes in this config), or split large code sets.`,
    );
  }
}

function buildNodeOptions(redeemable: DiscountCode[]): CodeDiscountNodeOptions {
  // usageLimit / appliesOncePerCustomer are node-wide on Shopify, so they only
  // mirror per-code settings when that's equivalent: one live code for the
  // limit, every live code once-per-customer for the customer rule. Per-code
  // limits otherwise rely on the orders webhook exhausting the code.
  const [only] = redeemable;
  return {
    endsAt: null,
    usageLimit: redeemable.length === 1 && only?.usageLimit != null ? only.usageLimit : null,
    appliesOncePerCustomer:
      redeemable.length > 0 && redeemable.every((code) => code.oncePerCustomer),
  };
}

/**
 * Takes every code that must no longer work off its live node: disabled,
 * exhausted, expired or not-yet-started codes are removed, and a node left with
 * no redeemable code is expired outright. Runs before anything that can throw
 * so a deactivation is honored even if some other offer's publish fails.
 */
async function retireInactiveCodes(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  codeOffers: Offer[],
  codesByOffer: Map<string, DiscountCode[]>,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  for (const offer of codeOffers) {
    const rows = codesByOffer.get(offer.id) ?? [];
    if (rows.length === 0 || !offer.codeDiscountId) continue;
    const stale = rows.filter((row) => row.shopifySyncedAt && !isCodeRedeemable(row, now));
    if (stale.length > 0) {
      await removeRedeemCodes(
        shopDomain,
        accessToken,
        offer.codeDiscountId,
        stale.map((row) => row.code),
      );
      await db
        .update(discountCodes)
        .set({ shopifySyncedAt: null })
        .where(
          and(
            eq(discountCodes.shopId, shopId),
            inArray(
              discountCodes.id,
              stale.map((row) => row.id),
            ),
          ),
        );
    }
    if (!rows.some((row) => isCodeRedeemable(row, now))) {
      await expireCodeDiscountNode(shopDomain, accessToken, offer.codeDiscountId);
    }
  }
}

/**
 * Ensures each active code offer has its own `discountCodeAppCreate` node
 * (creating and persisting one if needed) and compiles its config, but does
 * NOT push anything to Shopify yet. Split out from the actual push so the
 * compiled result can be folded into the shop-wide cart-validation config
 * before any discount config goes live.
 */
async function compileCodeOffers(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  codeOffers: Offer[],
  codesByOffer: Map<string, DiscountCode[]>,
): Promise<CompiledCodeOffer[]> {
  const db = getDb();
  const now = new Date();
  const functions: Partial<Record<CodeNodeKind, ShopifyFunctionSummary>> = {};
  const functionFor = async (kind: CodeNodeKind) =>
    (functions[kind] ??=
      kind === "delivery"
        ? await findDeliveryDiscountFunction(shopDomain, accessToken)
        : await findCartDiscountFunction(shopDomain, accessToken));
  const results: CompiledCodeOffer[] = [];

  for (const offer of codeOffers) {
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
    const kind = codeNodeKind(rewardRows);

    const ownRows = codesByOffer.get(offer.id) ?? [];
    const legacyCode = ownRows.length === 0 ? offer.requiredDiscountCode : null;

    let discountId = offer.codeDiscountId;
    if (discountId) {
      const functionId = await getCodeDiscountFunctionId(shopDomain, accessToken, discountId);
      if (functionId === null) {
        discountId = null;
      } else if (functionId !== undefined && functionId !== (await functionFor(kind)).id) {
        // The offer's rewards moved between the cart and delivery Functions;
        // a node can't change Function, so replace it (the codes follow below).
        await deleteCodeDiscountNode(shopDomain, accessToken, discountId);
        discountId = null;
      }
      if (!discountId && ownRows.length > 0) {
        await db
          .update(discountCodes)
          .set({ shopifySyncedAt: null })
          .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offer.id)));
        for (const row of ownRows) row.shopifySyncedAt = null;
      }
    }

    // Before anything is attached or a node is created, make sure none of the codes
    // about to go live collides with a discount the merchant made in Shopify. A
    // collision is resolved on our side (regenerate / suffixed variant), never by
    // touching their discount.
    const pendingRows = ownRows.filter((row) => !row.shopifySyncedAt && isCodeRedeemable(row, now));
    if (pendingRows.length > 0) {
      const resolution = await resolveCodeCollisions(
        pendingRows,
        { shopDomain, accessToken, ownNodeId: discountId, offerName: offer.internalName },
        await batchShapes(shopId, pendingRows),
      );
      await markCodesSynced(shopId, resolution.alreadyOurs);
    }
    const redeemableCodes = ownRows.filter((row) => isCodeRedeemable(row, now));
    const liveCodes = legacyCode ? [legacyCode] : redeemableCodes.map((row) => row.code);

    // Nothing redeemable: retireInactiveCodes already expired any live node, and
    // pushing a config below would reopen it.
    if (liveCodes.length === 0) continue;

    const nodeOptions = buildNodeOptions(redeemableCodes);
    if (!discountId) {
      const [primary] = liveCodes;
      if (!primary) continue;
      discountId = await createOrFindCodeDiscount(
        shopDomain,
        accessToken,
        await functionFor(kind),
        primary,
        codeNodeTitle(offer),
        kind === "delivery" ? DELIVERY_DISCOUNT_CLASSES : CART_DISCOUNT_CLASSES,
        nodeOptions,
      );
      await db
        .update(offers)
        .set({ codeDiscountId: discountId, updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offer.id)));
      const primaryRow = redeemableCodes.find((row) => row.code === primary);
      if (primaryRow) {
        primaryRow.shopifySyncedAt = now;
        await db
          .update(discountCodes)
          .set({ shopifySyncedAt: now })
          .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.id, primaryRow.id)));
      }
    }

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
      { codePromo: true },
    );
    const [resolvedOffer] = await resolveLegacyGiftVariants(shopId, [compiledOffer]);
    const finalCompiledOffer = resolvedOffer ?? compiledOffer;

    results.push({
      offer,
      kind,
      discountId,
      compiledOffer: finalCompiledOffer,
      shippingOffers:
        kind === "delivery"
          ? compileShippingOfferConfigs(offer, functionConditionRows, rewardRows)
          : [],
      gatedShippingOffers:
        kind === "cart" && rewardRows.some((reward) => reward.rewardType === "shipping_discount")
          ? compileShippingOfferConfigs(offer, functionConditionRows, rewardRows, {
              codeHashes: [...new Set(liveCodes.map(codeHash))].sort(),
            })
          : [],
      conditionRows,
      redeemableCodes,
      pendingCodes: redeemableCodes.filter((row) => !row.shopifySyncedAt),
      nodeOptions,
    });
  }

  return results;
}

/**
 * Pushes each already-compiled code offer's guardrails (combination policy)
 * then its single-offer config to its dedicated node, then attaches any codes
 * not yet on the node. Guardrails before config, matching the shared path's
 * "stop discount generation only after validation/combination are safe" order.
 */
async function pushCodeOfferConfigs(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  compiledCodeOffers: CompiledCodeOffer[],
): Promise<void> {
  const db = getDb();

  for (const entry of compiledCodeOffers) {
    const { offer, kind, discountId, compiledOffer, conditionRows } = entry;
    const customerTags = [
      ...new Set([
        ...(compiledOffer.requiredCustomerTags ?? []),
        ...(compiledOffer.excludedCustomerTags ?? []),
      ]),
    ].sort();

    // customerTags/query-variables must be set here exactly as the shared
    // config sets them, or a customer-tag or cart-attribute condition on this
    // offer silently never matches: the Function reads those off this same
    // config, not the shared one. A delivery node only carries shippingOffers.
    const singleOfferConfig: CompiledFunctionConfig = {
      offers: kind === "delivery" ? [] : [compiledOffer],
      shippingOffers: entry.shippingOffers,
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
      kind === "delivery" ? DELIVERY_DISCOUNT_CLASSES : CART_DISCOUNT_CLASSES,
      entry.nodeOptions,
    );
    await pushMetafields(shopDomain, accessToken, [discountId], value);

    // A code can be taken between the pre-flight and the bulk job (a race): treat any
    // per-code failure like a pre-flight collision (regenerate / suffix), then add the
    // replacements, so the publish completes with every code live.
    let toAdd = entry.pendingCodes;
    for (let round = 0; toAdd.length > 0; round += 1) {
      const failed = await addRedeemCodes(
        shopDomain,
        accessToken,
        discountId,
        toAdd.map((row) => row.code),
      );
      const failedCodes = new Set(failed.map((item) => item.code.toUpperCase()));
      const added = toAdd.filter((row) => !failedCodes.has(row.code));
      if (added.length > 0) {
        const syncedAt = new Date();
        await db
          .update(discountCodes)
          .set({ shopifySyncedAt: syncedAt })
          .where(
            and(
              eq(discountCodes.shopId, shopId),
              inArray(
                discountCodes.id,
                added.map((row) => row.id),
              ),
            ),
          );
        for (const row of added) row.shopifySyncedAt = syncedAt;
      }
      if (failed.length === 0) break;
      const failedRows = toAdd.filter((row) => failedCodes.has(row.code));
      if (round >= 3) {
        const sample = failed
          .slice(0, 3)
          .map((item) => `${item.code} (${item.message})`)
          .join(", ");
        throw new Error(
          `Shopify kept rejecting ${failed.length} code(s) for "${offer.internalName}": ${sample}.`,
        );
      }
      const resolution = await resolveCodeCollisions(
        failedRows,
        { shopDomain, accessToken, ownNodeId: discountId, offerName: offer.internalName },
        await batchShapes(shopId, failedRows),
      );
      await markCodesSynced(shopId, resolution.alreadyOurs);
      toAdd = failedRows.filter((row) => !resolution.alreadyOurs.includes(row));
    }

    await db
      .update(offers)
      .set({ compiledConfig: compiledOffer })
      .where(and(eq(offers.shopId, shopId), eq(offers.id, offer.id)));
  }
}

interface CompiledBackendBOffer {
  offer: Offer;
  compiledOffer: CompiledFunctionConfig["offers"][number];
  /** False for shipping-only offers: nothing for the cart-lines code Function to do. */
  hasCartRewards: boolean;
  gatedShippingOffers: CompiledShippingOffer[];
  conditionRows: OfferCondition[];
}

/**
 * Backend B: compiles each code offer for the code Function, with the hashes of
 * its redeemable codes. Anything the Function can't enforce is a publish error,
 * never a silent pass: shipping rewards (no delivery counterpart), custom cart
 * attributes (the query has no slots for them), and more codes than fit in the
 * metafield.
 */
async function compileBackendBOffers(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  codeOffers: Offer[],
  codesByOffer: Map<string, DiscountCode[]>,
): Promise<CompiledBackendBOffer[]> {
  const db = getDb();
  const now = new Date();
  const results: CompiledBackendBOffer[] = [];
  for (const offer of codeOffers) {
    const ownRows = codesByOffer.get(offer.id) ?? [];
    const codes =
      ownRows.length === 0 && offer.requiredDiscountCode
        ? [offer.requiredDiscountCode]
        : ownRows.filter((row) => isCodeRedeemable(row, now)).map((row) => row.code);
    if (codes.length === 0) continue;

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
    if (conditionRows.some((row) => row.isEnabled && row.conditionType === "cart_attribute")) {
      throw new Error(
        `"${offer.internalName}" combines discount codes with a cart attribute condition, which the code Function (backend B) can't read. Remove the cart attribute condition or use backend A.`,
      );
    }
    const policy = policyRows[0] ?? null;
    const functionConditionRows = conditionRows.some(
      (condition) => condition.isEnabled && condition.conditionType === "markets",
    )
      ? resolveMarketConditionsToCountries(
          conditionRows,
          await syncMarketsForShop(shopId, shopDomain, accessToken),
        )
      : conditionRows;
    const compiled = compileOfferConfig(
      offer,
      functionConditionRows,
      rewardRows,
      policy,
      computeOfferVersion(offer, conditionRows, rewardRows, policy),
      { codePromo: true, codeHashes: [...new Set(codes.map(codeHash))].sort() },
    );
    const [resolved] = await resolveLegacyGiftVariants(shopId, [compiled]);
    const hashes = [...new Set(codes.map(codeHash))].sort();
    results.push({
      offer,
      compiledOffer: resolved ?? compiled,
      hasCartRewards: rewardRows.some((reward) => reward.rewardType !== "shipping_discount"),
      // Backend B has no Shopify code behind these, so the delivery Function accepts them itself.
      gatedShippingOffers: compileShippingOfferConfigs(offer, functionConditionRows, rewardRows, {
        codeHashes: hashes,
        acceptCodes: true,
      }),
      conditionRows,
    });
  }
  return results;
}

/** Pushes backend B's config; also empties it when no code offer uses B any more (flag off, shadow mode, none left). */
async function pushBackendBConfig(
  shopId: string,
  shopDomain: string,
  accessToken: string,
  allCompiled: CompiledBackendBOffer[],
): Promise<void> {
  const compiled = allCompiled.filter((entry) => entry.hasCartRewards);
  if (compiled.length === 0) {
    const nodeId = await findCodeDiscountNode(shopId, shopDomain, accessToken);
    if (nodeId) {
      await pushMetafields(
        shopDomain,
        accessToken,
        [nodeId],
        serializeFunctionConfig(emptyFunctionConfig(), { omitCartAttributeSlots: true }),
      );
    }
    return;
  }
  const customerTags = [
    ...new Set(
      compiled.flatMap((entry) => [
        ...(entry.compiledOffer.requiredCustomerTags ?? []),
        ...(entry.compiledOffer.excludedCustomerTags ?? []),
      ]),
    ),
  ].sort();
  const config: CompiledFunctionConfig = {
    offers: compiled.map((entry) => entry.compiledOffer),
    shippingOffers: [],
    version: "1",
    compiledAt: new Date().toISOString(),
    ...(customerTags.length > 0 ? { customerTags } : {}),
  };
  const value = serializeFunctionConfig(config, { omitCartAttributeSlots: true });
  const sizeBytes = new TextEncoder().encode(value).byteLength;
  if (sizeBytes > MAX_METAFIELD_BYTES) {
    throw new Error(
      `Code Function config is ${sizeBytes}B, exceeding the safe ${MAX_METAFIELD_BYTES}B limit: too many codes for backend B. Use backend A, or fewer codes.`,
    );
  }
  const nodeId = await ensureCodeDiscountNode(shopId, shopDomain, accessToken);
  await syncDiscountCombinationPolicy(
    shopDomain,
    accessToken,
    nodeId,
    compileDiscountCombinationPolicy(compiled.map((entry) => entry.compiledOffer)),
    CART_DISCOUNT_CLASSES,
  );
  await pushMetafields(shopDomain, accessToken, [nodeId], value);
  const db = getDb();
  for (const entry of compiled) {
    await db
      .update(offers)
      .set({ compiledConfig: entry.compiledOffer })
      .where(and(eq(offers.shopId, shopId), eq(offers.id, entry.offer.id)));
  }
}

/**
 * Empties the compiled config (and expires the node) on any offer whose
 * `codeDiscountId` is still set but that isn't part of the currently active
 * code-offer set. The node itself, and its codes, stay: only what the Function
 * serves is cleared, the same "stop discount generation" pattern the shared
 * automatic path uses for zero active offers.
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

  const emptyValue = serializeFunctionConfig(emptyFunctionConfig());
  for (const discountId of staleDiscountIds) {
    await pushMetafields(shopDomain, accessToken, [discountId], emptyValue);
    await expireCodeDiscountNode(shopDomain, accessToken, discountId);
  }
}

function emptyFunctionConfig(): CompiledFunctionConfig {
  return { offers: [], shippingOffers: [], version: "1", compiledAt: new Date().toISOString() };
}

/**
 * Empties a single code-gated offer's discount node directly, by id — used
 * when hard-deleting an offer. `neutralizeStaleCodeOffers` (run on every
 * regular publish) only ever looks at offers still present in the `offers`
 * table, so deleting the row first would make a code-gated offer invisible
 * to it forever, leaving its real, live Shopify discount code enterable at
 * checkout indefinitely with whatever config it last had. The node is also
 * expired, so the codes stop being accepted at all.
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

  await pushMetafields(
    shopDomain,
    accessToken,
    [discountId],
    serializeFunctionConfig(emptyFunctionConfig()),
  );
  await expireCodeDiscountNode(shopDomain, accessToken, discountId);
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
    return [
      {
        ...offer,
        giftRewards,
        giftVariantIds: [...new Set(giftRewards.flatMap((reward) => reward.targetVariantIds))],
      },
    ];
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
