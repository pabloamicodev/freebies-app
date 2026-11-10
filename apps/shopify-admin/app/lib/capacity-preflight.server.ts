import { and, eq, inArray, or } from "drizzle-orm";
import {
  appSettings,
  discountCodes,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  shops,
  type Db,
} from "@promo/db";
import { compileDiscountCombinationPolicy, serializeFunctionConfig } from "./sync/compile-config.js";
import { compileCartOffers, legacyGatedOfferIds } from "./sync/cart-offers.server.js";
import { isLimitsEnforced } from "./limits-enforced.server.js";
import { buildAttributeQueryVariables, MAX_CUSTOM_CART_ATTRIBUTE_KEYS } from "./sync/attribute-query-variables.js";
import { planShards, SLOT_LIMITS, type PlanBlockCode } from "./sync/shard-planner.js";
import { baseOfferId, buildPlanUnitSet, cartAttributeKeysOf } from "./sync/plan-units.js";
import type { SplitRefusal } from "./sync/offer-split.js";
import { loadSplitOptions } from "./sync/variant-products.server.js";
import { combinationBlockers, type CombinationBlocker } from "./sync/combination-blockers.js";
import { isCheckoutCodeGated } from "./code-redemption.js";
import { MAX_METAFIELD_BYTES } from "./sync/offer-publisher.server.js";
import { buildCartValidationConfig, MAX_VALIDATION_CONFIG_BYTES } from "./cart-validation.server.js";
import { OfferPublishError } from "./offer-publish-errors.server.js";
import { isFunctionCompactIdsEnabled } from "./function-compact-ids-flag.server.js";
import { isFunctionShardsEnabled } from "./function-shards-flag.server.js";
import { countShardNodes, readPreviousAssignment } from "./sync/cart-shards.server.js";
import {
  automaticNodeBudget,
  CART_SHARD_POOL_SETTING,
  MAX_CART_SLOTS,
  type AutomaticNodeBudget,
} from "./discount-node.server.js";
import { redisGetString, redisSetString } from "./redis.server.js";
import { decryptToken } from "./token-crypto.server.js";
import {
  automaticDiscountCountUnknownMessage,
  automaticDiscountLimitMessage,
  combinationSingleShardMessage,
  offerTooLargeMessage,
  sharedConfigTooLargeMessage,
  shippingConfigTooLargeMessage,
  slot0GroupTooLargeMessage,
  validationConfigTooLargeMessage,
} from "./capacity-copy.js";

export { sharedConfigTooLargeMessage, shippingConfigTooLargeMessage };

const encodedBytes = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * Compiles the shared automatic config as the publisher would build it if `includeOfferIds` ran
 * through it alongside every active non-code offer (`forceInclude`: even a code-gated one, for an
 * offer about to switch to automatic). Same compile as the publisher (`compileCartOffers`);
 * approximation: skips market-to-country resolution, which needs Shopify.
 */
export async function compileSharedOffers(
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
  const [codeRows, conditions, rewards, policies, limitsEnforced] = await Promise.all([
    db.select({ offerId: discountCodes.offerId }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), inArray(discountCodes.offerId, ids))),
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, ids))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, ids))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), inArray(offerCombinationPolicies.offerId, ids))),
    isLimitsEnforced(db, shopId),
  ]);
  const withCodes = new Set(codeRows.map((row) => row.offerId));
  const extra = new Set(forceInclude ? includeOfferIds : []);
  const heldBack = legacyGatedOfferIds(conditions);
  const shared = rows.filter(
    (offer) => !heldBack.has(offer.id) && (extra.has(offer.id) || !isCheckoutCodeGated(offer, withCodes.has(offer.id))),
  );
  const sharedIds = new Set(shared.map((offer) => offer.id));
  const sharedPolicies = policies.filter((policy) => sharedIds.has(policy.offerId));
  const entries = await compileCartOffers(db, shopId, shared, { conditions, rewards, policies: sharedPolicies, shopCurrencyCode, limitsEnforced });
  const compiled = entries.map(({ source, offer, shipping }) => ({
    offerId: source.id,
    offer,
    shipping,
    conditions: conditions.filter((c) => c.offerId === source.id),
    name: source.internalName,
  }));
  const compactIds = await isFunctionCompactIdsEnabled(db, shopId);
  return {
    compiled,
    policies: sharedPolicies,
    compactIds,
    config: (extraFields: Record<string, string> = {}) =>
      serializeFunctionConfig({
        offers: compiled.map((entry) => entry.offer),
        shippingOffers: [],
        version: "1",
        compiledAt: "2026-01-01T00:00:00.000Z",
        ...extraFields,
      }, { compactIds }),
    deliveryConfig: () =>
      serializeFunctionConfig(
        {
          offers: [],
          shippingOffers: compiled.flatMap((entry) => entry.shipping),
          version: "1",
          compiledAt: "2026-01-01T00:00:00.000Z",
        },
        { omitQueryVariables: true, compactIds },
      ),
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

export interface SharedConfigBreakdown {
  totalBytes: number;
  /** Size of the delivery node's config (shipping offers only). */
  deliveryBytes: number;
  validationBytes: number;
  perOffer: Array<{ offerId: string; name: string; bytes: number }>;
}

/** Size of the shared automatic config as published today, with each offer's own share (read-only). */
export async function sharedConfigBreakdown(
  db: Db,
  shopId: string,
  shopCurrencyCode: string,
): Promise<SharedConfigBreakdown> {
  const shared = await compileSharedOffers(db, shopId, shopCurrencyCode, [], false);
  if (!shared) return { totalBytes: 0, deliveryBytes: 0, validationBytes: 0, perOffer: [] };
  return {
    totalBytes: encodedBytes(shared.config()),
    deliveryBytes: encodedBytes(shared.deliveryConfig()),
    validationBytes: encodedBytes(JSON.stringify(buildCartValidationConfig(shared.compiled.map((entry) => entry.offer)))),
    perOffer: shared.compiled.map((entry) => ({
      offerId: entry.offerId,
      name: entry.name,
      bytes: encodedBytes(JSON.stringify(entry.offer)),
    })),
  };
}

export type CapacityCode =
  | PlanBlockCode
  | "SHIPPING_CONFIG_TOO_LARGE"
  | "VALIDATION_CONFIG_TOO_LARGE"
  | "CART_ATTRIBUTE_KEYS"
  | "COMBINATION_SINGLE_SHARD"
  | "COMPILE_ERROR";

export interface CapacityBudget {
  storeActive: number | null;
  ours: number;
  others: number | null;
}

export type CapacityPreflight =
  | {
      ok: true;
      plan: {
        slots: number;
        bytesPerSlot: number[];
        offersPerSlot?: number[];
        deliveryBytes: number;
        maxSlots: number;
        budget: CapacityBudget | null;
        singleShardReason?: "flag_off" | "combination" | "budget";
        combinationBlockers?: CombinationBlocker[];
      };
    }
  | {
      ok: false;
      code: CapacityCode;
      offerIds: string[];
      offerNames: string[];
      numbers: Record<string, number>;
      reason?: "bytes" | "keys" | "tags" | "combination";
      /** OFFER_TOO_LARGE with sharding on: why the offer cannot be split across slots (offer-split.ts reason code). */
      splitRefusal?: SplitRefusal;
      message: string;
    };

export type CapacityFailure = Extract<CapacityPreflight, { ok: false }>;

export interface CapacityOptions {
  /** Overrides the per-shop flag (tests, diagnostics). */
  shardsEnabled?: boolean;
  /** Count the offers in `offerIds` even when code-gated (an offer about to switch to automatic). */
  forceInclude?: boolean;
  /** Overrides how the live automatic-discount budget is read (default: Redis-cached `automaticNodeBudget`). */
  loadBudget?: (db: Db, shopId: string) => Promise<AutomaticNodeBudget | null>;
}

const BUDGET_FRESH_MS = 5 * 60_000;
const BUDGET_KEEP_SECONDS = 24 * 3600;
const budgetKey = (shopId: string) => `capacity:budget:${shopId}`;

async function readCachedBudget(shopId: string): Promise<{ at: number; budget: AutomaticNodeBudget } | null> {
  try {
    const raw = await redisGetString(budgetKey(shopId));
    return raw ? (JSON.parse(raw) as { at: number; budget: AutomaticNodeBudget }) : null;
  } catch {
    return null;
  }
}

/** Live count cached 5 min in Redis; a stale entry (up to 24h) stands in when Shopify or Redis fail. */
export async function loadAutomaticBudget(db: Db, shopId: string): Promise<AutomaticNodeBudget | null> {
  const cached = await readCachedBudget(shopId);
  if (cached && Date.now() - cached.at < BUDGET_FRESH_MS) return cached.budget;
  try {
    const [shop] = await db
      .select({ domain: shops.myshopifyDomain, token: shops.accessTokenEncrypted })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);
    if (!shop) return cached?.budget ?? null;
    const budget = await automaticNodeBudget(shopId, shop.domain, await decryptToken(shop.token));
    try {
      await redisSetString(budgetKey(shopId), JSON.stringify({ at: Date.now(), budget }), BUDGET_KEEP_SECONDS);
    } catch {
      /* cache is best effort */
    }
    return budget;
  } catch {
    return cached?.budget ?? null;
  }
}

export { readPreviousAssignment };

async function fallbackMaxSlots(db: Db, shopId: string): Promise<number> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, CART_SHARD_POOL_SETTING)))
    .limit(1);
  let shards = 0;
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : [];
    shards = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    /* unreadable pool: treat as none */
  }
  return Math.min(MAX_CART_SLOTS, Math.max(shards, await countShardNodes(db, shopId)) + 2);
}

/**
 * Plans the cart shards in memory exactly as the publisher will and returns a structured, attributable
 * error before any status changes. Only Shopify call: the (cached) automatic discount count, and only
 * when the shop has sharding on.
 */
export async function preflightCapacity(
  db: Db,
  shopId: string,
  offerIds: string[],
  opts: CapacityOptions = {},
): Promise<CapacityPreflight> {
  const [shop] = await db.select({ currencyCode: shops.currencyCode }).from(shops).where(eq(shops.id, shopId));
  let shared;
  try {
    shared = await compileSharedOffers(db, shopId, shop?.currencyCode ?? "USD", offerIds, opts.forceInclude === true);
  } catch (error) {
    if (error instanceof OfferPublishError) {
      return { ok: false, code: "COMPILE_ERROR", offerIds: [error.offerId], offerNames: [], numbers: {}, message: error.message };
    }
    throw error;
  }
  if (!shared) {
    return { ok: true, plan: { slots: 1, bytesPerSlot: [0], deliveryBytes: 0, maxSlots: 1, budget: null } };
  }

  const names = new Map(shared.compiled.map((entry) => [entry.offerId, entry.name]));
  const nameList = (ids: string[]) => ids.map((id) => names.get(id) ?? id);
  const fail = (
    code: CapacityCode,
    ids: string[],
    numbers: Record<string, number>,
    message: (offerNames: string[]) => string,
    reason?: "bytes" | "keys" | "tags" | "combination",
    splitRefusal?: SplitRefusal,
  ): CapacityPreflight => {
    const unique = [...new Set(ids)];
    const offerNames = nameList(unique);
    return {
      ok: false,
      code,
      offerIds: unique,
      offerNames,
      numbers,
      message: message(offerNames),
      ...(reason ? { reason } : {}),
      ...(splitRefusal ? { splitRefusal } : {}),
    };
  };

  const conditions = shared.compiled.flatMap((entry) => entry.conditions);
  const enabled = opts.shardsEnabled ?? (await isFunctionShardsEnabled(db, shopId));
  const budget = enabled ? await (opts.loadBudget ?? loadAutomaticBudget)(db, shopId) : null;
  const maxSlots = enabled ? (budget?.maxCartSlots ?? (await fallbackMaxSlots(db, shopId))) : 1;

  if (maxSlots <= 1) {
    try {
      buildAttributeQueryVariables(conditions);
    } catch (error) {
      const users = shared.compiled.filter((entry) => cartAttributeKeysOf(entry.conditions).length > 0);
      return fail(
        "CART_ATTRIBUTE_KEYS",
        users.map((entry) => entry.offerId),
        { keys: cartAttributeKeysOf(conditions).length, maxKeys: MAX_CUSTOM_CART_ATTRIBUTE_KEYS },
        (offerNames) => `${(error as Error).message} Offers using them: ${offerNames.map((name) => `"${name}"`).join(", ")}.`,
      );
    }
  }

  const splitOptions = enabled ? await loadSplitOptions(db, shopId, shared.compiled.map((entry) => entry.offer)) : {};
  const planOptions = { ...splitOptions, compactIds: shared.compactIds };
  const { units } = buildPlanUnitSet(shared.compiled, conditions, shared.policies, planOptions);
  const previous = await readPreviousAssignment(db, shopId);
  const policy = compileDiscountCombinationPolicy(shared.compiled.map((entry) => entry.offer));
  const plan = planShards(units, previous, { ...SLOT_LIMITS, maxSlots, maxTags: enabled ? SLOT_LIMITS.maxTags : Infinity }, policy);
  const blockers = combinationBlockers(shared.compiled, units.some((unit) => unit.hasOrderRewards));
  const combinationForcesSingle = enabled && maxSlots > 1 && blockers.length > 0;
  let blocked = plan.blocked;
  if (blocked && enabled && maxSlots < MAX_CART_SLOTS && blocked.code !== "AUTOMATIC_DISCOUNT_LIMIT") {
    // The budget, not the offers, may be what is short: replan with every slot to learn how many are needed.
    const wide = planShards(units, previous, { ...SLOT_LIMITS, maxSlots: MAX_CART_SLOTS, maxTags: enabled ? SLOT_LIMITS.maxTags : Infinity }, policy);
    if (!wide.blocked) {
      blocked = {
        code: "AUTOMATIC_DISCOUNT_LIMIT",
        unitKeys: blocked.unitKeys,
        numbers: { needed: wide.slots.length, allowed: maxSlots },
      };
    } else blocked = wide.blocked;
  }
  if (blocked) {
    const ids = blocked.unitKeys.map(baseOfferId);
    const numbers = blocked.numbers;
    switch (blocked.code) {
      case "SLOT_FULL":
        if (combinationForcesSingle) {
          return fail(
            "COMBINATION_SINGLE_SHARD",
            blockers.map((blocker) => blocker.offerId),
            { bytes: numbers["neededBytes"] ?? 0, slotBytes: numbers["slotBytes"] ?? SLOT_LIMITS.slotBytes, offersBlocking: blockers.length },
            combinationSingleShardMessage,
            "combination",
          );
        }
        return fail("SLOT_FULL", ids, numbers, (n) => sharedConfigTooLargeMessage(numbers["neededBytes"] ?? 0, n));
      case "AUTOMATIC_DISCOUNT_LIMIT": {
        const needed = (numbers["needed"] ?? 0) - (numbers["allowed"] ?? 0);
        const storeActive = budget?.storeActive ?? (budget && budget.others !== null ? budget.others + budget.ours : null);
        if (storeActive === null) {
          return fail("AUTOMATIC_DISCOUNT_LIMIT", ids, { ...numbers, needed }, automaticDiscountCountUnknownMessage);
        }
        return fail(
          "AUTOMATIC_DISCOUNT_LIMIT",
          ids,
          { ...numbers, needed, storeActive, ...(budget?.others != null ? { others: budget.others } : {}) },
          () => automaticDiscountLimitMessage(storeActive, needed),
        );
      }
      case "SLOT0_GROUP_TOO_LARGE":
        return fail("SLOT0_GROUP_TOO_LARGE", ids, numbers, (n) => slot0GroupTooLargeMessage(numbers["groupUnits"] ?? n.length, n));
      case "OFFER_TOO_LARGE":
      case "GROUP_TOO_LARGE":
        if (!enabled && blocked.reason === "bytes") {
          return fail("SLOT_FULL", ids, { ...numbers, neededBytes: numbers["bytes"] ?? 0 }, (n) => sharedConfigTooLargeMessage(numbers["bytes"] ?? 0, n));
        }
        return fail(
          blocked.code,
          ids,
          numbers,
          (n) => offerTooLargeMessage(n, blocked.reason ?? "bytes", numbers, blocked.code === "GROUP_TOO_LARGE"),
          blocked.reason,
          enabled && blocked.code === "OFFER_TOO_LARGE" ? blocked.splitRefusal : undefined,
        );
    }
  }

  const deliveryBytes = encodedBytes(shared.deliveryConfig());
  if (deliveryBytes > MAX_METAFIELD_BYTES) {
    return fail(
      "SHIPPING_CONFIG_TOO_LARGE",
      shared.compiled.filter((entry) => entry.shipping.length > 0).map((entry) => entry.offerId),
      { bytes: deliveryBytes, limit: MAX_METAFIELD_BYTES },
      () => shippingConfigTooLargeMessage(deliveryBytes),
    );
  }

  const validationBytes = encodedBytes(
    JSON.stringify(buildCartValidationConfig(shared.compiled.map((entry) => entry.offer))),
  );
  if (validationBytes > MAX_VALIDATION_CONFIG_BYTES) {
    return fail(
      "VALIDATION_CONFIG_TOO_LARGE",
      shared.compiled.filter((entry) => entry.offer.giftRewards.length > 0).map((entry) => entry.offerId),
      { bytes: validationBytes, limit: MAX_VALIDATION_CONFIG_BYTES },
      () => validationConfigTooLargeMessage(validationBytes, MAX_VALIDATION_CONFIG_BYTES),
    );
  }

  return {
    ok: true,
    plan: {
      slots: plan.slots.length,
      bytesPerSlot: plan.slots.map((slot) => slot.bytes),
      offersPerSlot: plan.slots.map((slot) => new Set(slot.unitKeys.map(baseOfferId)).size),
      deliveryBytes,
      maxSlots,
      budget: budget ? { storeActive: budget.storeActive, ours: budget.ours, others: budget.others } : null,
      ...(!enabled
        ? { singleShardReason: "flag_off" as const }
        : combinationForcesSingle
          ? { singleShardReason: "combination" as const, combinationBlockers: blockers }
          : maxSlots <= 1
            ? { singleShardReason: "budget" as const }
            : {}),
    },
  };
}
