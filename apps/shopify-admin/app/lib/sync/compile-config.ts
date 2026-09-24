/**
 * Compile an offer's conditions and rewards into the compact JSON config
 * pushed to Shopify metafields and consumed by the Rust Discount Function.
 */

import type {
  offers as OffersTable,
  offerConditions as ConditionsTable,
  offerRewards as RewardsTable,
  offerCombinationPolicies as PoliciesTable,
} from "@promo/db";
import { normalizeConditionValue } from "../offer-config-normalization.server.js";

export interface CompiledFunctionConfig {
  offers: CompiledOffer[];
  shippingOffers: CompiledShippingOffer[];
  version: string;
  compiledAt: string;
  l1?: string;
  l2?: string;
  l3?: string;
  l4?: string;
  l5?: string;
  l6?: string;
  c1?: string;
  c2?: string;
  c3?: string;
  customerTags?: string[];
}

export interface CompiledShippingTier {
  minimumSubtotalCents: number;
  discountType: "percentage" | "fixed_amount";
  discountValue: number;
  appliesWhen?: "has_subscription" | "one_time_only";
}

export interface CompiledShippingOffer {
  id: string;
  priority: number;
  tiers: CompiledShippingTier[];
  targetGroupTypes: Array<"ONE_TIME_PURCHASE" | "SUBSCRIPTION">;
  scopeMode: "sitewide" | "landing" | "quiz_bundle";
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds: string[];
  requiredAnchorMinQuantity: number;
  requiresAnchorSubscription: boolean;
}

export interface CompiledOffer {
  id: string;
  version: number;
  offerType: string;
  priority: number;
  stopLowerPriority: boolean;
  requiredProductIds: string[];
  requiredVariantIds: string[];
  excludedProductIds: string[];
  giftVariantIds: string[];
  giftProductIds: string[];
  cartValueThresholdCents?: number;
  cartValueMaxCents?: number;
  cartQuantityThreshold?: number;
  cartQuantityMax?: number;
  subscriptionMode?: "any" | "subscription_only" | "one_time_only";
  customerOrderCountMin?: number;
  customerOrderCountMax?: number;
  customerAmountSpentMinCents?: number;
  customerAmountSpentMaxCents?: number;
  requiredCustomerTags?: string[];
  excludedCustomerTags?: string[];
  treatGuestAsNoTags?: boolean;
  includeCountryCodes?: string[];
  excludeCountryCodes?: string[];
  maxGiftQuantity?: number;
  discountType: string;
  discountValue: number;
  currencyCode: string;
  currencyOverrides?: Record<string, number>;
  maxCurrencyOverrides?: Record<string, number>;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  combinesWithProductDiscounts: boolean;
  requirements: CompiledRequirement[];
  giftRewards: CompiledGiftReward[];
  productRewards: CompiledProductReward[];
  orderRewards: CompiledOrderReward[];
  lineAttributeConditions?: CompiledAttributeCondition[];
  cartAttributeConditions?: CompiledAttributeCondition[];
}

export interface CompiledAttributeCondition {
  key: string;
  value: string;
  matchMode: "equals" | "not_equals";
  minMatchingQuantity: number;
}

export interface CompiledRequirement {
  productId?: string;
  variantId?: string;
  trackMode: "product" | "variant";
  minQuantity: number;
  maxQuantity?: number;
}

export interface CompiledGiftReward {
  id: string;
  targetProductIds: string[];
  targetVariantIds: string[];
  discountType: string;
  discountValue: number;
  maxQuantity: number;
}

export interface CompiledProductReward {
  id: string;
  targetProductIds: string[];
  targetVariantIds: string[];
  discountType: string;
  discountValue: number;
  maxQuantity?: number;
  lineQuantityEquals?: number;
  maxUnitsTotal?: number;
  subscriptionMode: "any" | "subscription_only" | "one_time_only";
  scopeMode: "sitewide" | "landing" | "quiz_bundle";
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds: string[];
  requiredAnchorMinQuantity: number;
  requiresAnchorSubscription: boolean;
  priceTiers: Array<{ quantity: number; targetPricePerUnit: number }>;
  discountPercentageOnGifts: number;
}

export interface CompiledOrderReward {
  id: string;
  discountType: "percentage" | "fixed_amount" | "free";
  discountValue: number;
}

export interface CompiledDiscountCombinationPolicy {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

/**
 * Shopify applies combination rules to the automatic discount node, not to
 * individual candidates emitted by its Function. A single node hosts every
 * active offer, so the only safe aggregate is the most restrictive policy.
 */
export function compileDiscountCombinationPolicy(
  compiledOffers: CompiledOffer[],
): CompiledDiscountCombinationPolicy {
  return {
    orderDiscounts: compiledOffers.every((offer) => offer.combinesWithOrderDiscounts),
    productDiscounts: compiledOffers.every((offer) => offer.combinesWithProductDiscounts),
    shippingDiscounts: compiledOffers.every((offer) => offer.combinesWithShippingDiscounts),
  };
}

type OfferRow = typeof OffersTable.$inferSelect;
type ConditionRow = typeof ConditionsTable.$inferSelect;
type RewardRow = typeof RewardsTable.$inferSelect;
type PolicyRow = typeof PoliciesTable.$inferSelect;

export function compileOfferConfig(
  offer: OfferRow,
  conditions: ConditionRow[],
  rewards: RewardRow[],
  policy: PolicyRow | null,
  versionNumber: number,
): CompiledOffer {
  const config: CompiledOffer = {
    id: offer.id,
    version: versionNumber,
    offerType: offer.type,
    priority: offer.priority,
    stopLowerPriority: policy?.stopLowerPriority ?? false,
    requiredProductIds: [],
    requiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "free",
    discountValue: 100,
    currencyCode: "USD",
    combinesWithOrderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
    combinesWithShippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
    combinesWithProductDiscounts: policy?.combinesWithProductDiscounts ?? true,
    requirements: [],
    giftRewards: [],
    productRewards: [],
    orderRewards: [],
    lineAttributeConditions: [],
    cartAttributeConditions: [],
  };

  for (const cond of conditions.filter((c) => c.isEnabled)) {
    const value = normalizeConditionValue(cond.conditionType, cond.value as Record<string, unknown>);
    switch (cond.conditionType) {
      case "cart_value": {
        config.cartValueThresholdCents = Number(value["thresholdCents"] ?? 0);
        if (Number(value["maxCents"] ?? 0) > 0) config.cartValueMaxCents = Number(value["maxCents"]);
        if (value["currencyOverrides"]) config.currencyOverrides = value["currencyOverrides"] as Record<string, number>;
        if (value["maxCurrencyOverrides"]) config.maxCurrencyOverrides = value["maxCurrencyOverrides"] as Record<string, number>;
        const filter = value["scopeFilter"] as Record<string, string[]> | undefined;
        if (filter?.excludeProductIds) config.excludedProductIds.push(...filter.excludeProductIds);
        break;
      }
      case "cart_quantity":
        config.cartQuantityThreshold = Number(value["minQuantity"] ?? 0);
        if (Number(value["maxQuantity"] ?? 0) > 0) config.cartQuantityMax = Number(value["maxQuantity"]);
        break;
      case "subscription_product_type":
        if (
          value["mode"] === "any" ||
          value["mode"] === "subscription_only" ||
          value["mode"] === "one_time_only"
        ) {
          config.subscriptionMode = value["mode"];
        }
        break;
      case "order_history_total_orders": {
        const threshold = Math.max(0, Number(value["value"] ?? 0));
        applyIntegerBounds(config, "customerOrderCountMin", "customerOrderCountMax", cond.operator, threshold);
        break;
      }
      case "order_history_total_spent": {
        const threshold = Math.max(0, Number(value["valueCents"] ?? 0));
        applyIntegerBounds(config, "customerAmountSpentMinCents", "customerAmountSpentMaxCents", cond.operator, threshold);
        break;
      }
      case "specific_product": {
        const reqs = (value["requirements"] as Array<{
          productId?: string;
          variantId?: string;
          trackMode?: string;
          minQuantity?: number;
          maxQuantity?: number;
        }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId) config.requiredVariantIds.push(req.variantId);
          else if (req.productId) config.requiredProductIds.push(req.productId);
          config.requirements.push({
            ...(req.productId ? { productId: req.productId } : {}),
            ...(req.variantId ? { variantId: req.variantId } : {}),
            trackMode: req.trackMode === "variant" ? "variant" : "product",
            minQuantity: Math.max(1, Number(req.minQuantity ?? 1)),
            ...(req.maxQuantity === undefined ? {} : { maxQuantity: Number(req.maxQuantity) }),
          });
        }
        break;
      }
      case "pack_of_products": {
        const reqs = (value["requirements"] as Array<{
          productId?: string;
          variantId?: string;
          trackMode?: string;
          quantityPerPack?: number;
        }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId) config.requiredVariantIds.push(req.variantId);
          else if (req.productId) config.requiredProductIds.push(req.productId);
          config.requirements.push({
            ...(req.productId ? { productId: req.productId } : {}),
            ...(req.variantId ? { variantId: req.variantId } : {}),
            trackMode: req.trackMode === "variant" ? "variant" : "product",
            minQuantity: Math.max(1, Number(req.quantityPerPack ?? 1)),
          });
        }
        break;
      }
      case "exclude_products":
        config.excludedProductIds.push(...((value["productIds"] as string[]) ?? []));
        break;
      case "line_attribute":
        config.lineAttributeConditions!.push({
          key: String(value["key"] ?? ""),
          value: String(value["value"] ?? ""),
          matchMode: value["matchMode"] === "not_equals" ? "not_equals" : "equals",
          minMatchingQuantity: Math.max(1, Number(value["minMatchingQuantity"] ?? 1)),
        });
        break;
      case "cart_attribute":
        config.cartAttributeConditions!.push({
          key: String(value["key"] ?? ""),
          value: String(value["value"] ?? ""),
          matchMode: value["matchMode"] === "not_equals" ? "not_equals" : "equals",
          minMatchingQuantity: 1,
        });
        break;
      case "customer_tags":
        config.requiredCustomerTags = Array.isArray(value["includeTags"])
          ? value["includeTags"].filter((tag): tag is string => typeof tag === "string")
          : [];
        config.excludedCustomerTags = Array.isArray(value["excludeTags"])
          ? value["excludeTags"].filter((tag): tag is string => typeof tag === "string")
          : [];
        config.treatGuestAsNoTags = value["treatGuestAsNoTags"] !== false;
        break;
      case "customer_location":
        config.includeCountryCodes = Array.isArray(value["includeCountryCodes"])
          ? value["includeCountryCodes"].filter((code): code is string => typeof code === "string").map((code) => code.toUpperCase())
          : [];
        config.excludeCountryCodes = Array.isArray(value["excludeCountryCodes"])
          ? value["excludeCountryCodes"].filter((code): code is string => typeof code === "string").map((code) => code.toUpperCase())
          : [];
        break;
    }
  }

  for (const reward of rewards) {
    const target = reward.target as Record<string, unknown>;
    const value = reward.value as Record<string, unknown>;
    if (reward.rewardType === "product_gift") {
      const variantIds = (target["variantIds"] as string[]) ?? (target["variantId"] ? [target["variantId"] as string] : []);
      const productIds = (target["productIds"] as string[]) ?? (target["productId"] ? [target["productId"] as string] : []);
      config.giftVariantIds.push(...variantIds);
      config.giftProductIds.push(...productIds);
      if (reward.quantity) config.maxGiftQuantity = (config.maxGiftQuantity ?? 0) + reward.quantity;
      config.discountType = reward.discountType;
      config.discountValue = functionDiscountValue(
        reward.discountType,
        Number(value["amount"] ?? value["percentage"] ?? 100),
        String(value["currencyCode"] ?? "USD"),
      );
      config.giftRewards.push({
        id: reward.id,
        targetProductIds: productIds,
        targetVariantIds: variantIds,
        discountType: reward.discountType,
        discountValue: config.discountValue,
        maxQuantity: Math.max(1, reward.quantity ?? 1),
      });
    }
    if (
      reward.rewardType === "product_discount" ||
      reward.rewardType === "bundle_discount" ||
      reward.rewardType === "upsell_discount"
    ) {
      const targetVariantIds = (target["variantIds"] as string[]) ?? (target["variantId"] ? [target["variantId"] as string] : []);
      const targetProductIds = (target["productIds"] as string[]) ?? (target["productId"] ? [target["productId"] as string] : []);
      const currencyCode = String(value["currencyCode"] ?? "USD");
      config.productRewards.push({
        id: reward.id,
        targetProductIds,
        targetVariantIds,
        discountType: reward.discountType,
        discountValue: functionDiscountValue(reward.discountType, Number(value["amount"] ?? 0), currencyCode),
        ...(reward.quantity ? { maxQuantity: reward.quantity } : {}),
        ...(Number.isInteger(target["lineQuantityEquals"]) ? { lineQuantityEquals: Number(target["lineQuantityEquals"]) } : {}),
        ...(Number.isInteger(target["maxUnitsTotal"]) ? { maxUnitsTotal: Number(target["maxUnitsTotal"]) } : {}),
        subscriptionMode:
          target["subscriptionMode"] === "subscription_only" || target["subscriptionMode"] === "one_time_only"
            ? target["subscriptionMode"]
            : "any",
        scopeMode:
          target["scopeMode"] === "landing" || target["scopeMode"] === "quiz_bundle"
            ? target["scopeMode"]
            : "sitewide",
        ...(typeof target["requiredLineAttributeValue"] === "string"
          ? { requiredLineAttributeValue: target["requiredLineAttributeValue"] }
          : {}),
        requiredAnchorVariantIds: Array.isArray(target["requiredAnchorVariantIds"])
          ? target["requiredAnchorVariantIds"].filter((id): id is string => typeof id === "string")
          : [],
        requiredAnchorMinQuantity: Math.max(1, Number(target["requiredAnchorMinQuantity"] ?? 1)),
        requiresAnchorSubscription: target["requiresAnchorSubscription"] === true,
        priceTiers: Array.isArray(target["priceTiers"])
          ? target["priceTiers"].flatMap((tier) => {
              if (!tier || typeof tier !== "object") return [];
              const candidate = tier as Record<string, unknown>;
              const quantity = Number(candidate["quantity"]);
              const targetPricePerUnit = Number(candidate["targetPricePerUnit"]);
              return Number.isInteger(quantity) && quantity > 0 && Number.isFinite(targetPricePerUnit) && targetPricePerUnit >= 0
                ? [{ quantity, targetPricePerUnit }]
                : [];
            })
          : [],
        discountPercentageOnGifts: Math.min(100, Math.max(0, Number(target["discountPercentageOnGifts"] ?? 100))),
      });
    }
    if (reward.rewardType === "order_discount") {
      const currencyCode = String(value["currencyCode"] ?? "USD");
      const discountType = reward.discountType === "fixed_amount" ? "fixed_amount"
        : reward.discountType === "free" ? "free"
        : "percentage";
      config.orderRewards.push({
        id: reward.id,
        discountType,
        discountValue: functionDiscountValue(discountType, Number(value["amount"] ?? 0), currencyCode),
      });
    }
  }

  config.requiredProductIds = [...new Set(config.requiredProductIds)];
  config.requiredVariantIds = [...new Set(config.requiredVariantIds)];
  config.excludedProductIds = [...new Set(config.excludedProductIds)];
  config.giftVariantIds = [...new Set(config.giftVariantIds)];
  config.giftProductIds = [...new Set(config.giftProductIds)];

  return config;
}

function applyIntegerBounds(
  target: CompiledOffer,
  minKey: "customerOrderCountMin" | "customerAmountSpentMinCents",
  maxKey: "customerOrderCountMax" | "customerAmountSpentMaxCents",
  operator: string,
  threshold: number,
): void {
  const integerThreshold = Math.trunc(threshold);
  if (operator === "gte") target[minKey] = integerThreshold;
  if (operator === "gt") target[minKey] = integerThreshold + 1;
  if (operator === "lte") target[maxKey] = integerThreshold;
  if (operator === "lt") target[maxKey] = Math.max(-1, integerThreshold - 1);
  if (operator === "eq") {
    target[minKey] = integerThreshold;
    target[maxKey] = integerThreshold;
  }
}

function functionDiscountValue(discountType: string, storedAmount: number, currencyCode: string): number {
  if (discountType === "free") return 100;
  if (discountType === "percentage") return storedAmount;
  const zeroDecimalCurrencies = new Set([
    "JPY", "KRW", "VND", "BIF", "CLP", "GNF", "ISK", "KMF",
    "MGA", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF",
  ]);
  return zeroDecimalCurrencies.has(currencyCode.toUpperCase()) ? storedAmount : storedAmount / 100;
}

export function compileShippingOfferConfigs(
  offer: OfferRow,
  conditions: ConditionRow[],
  rewards: RewardRow[],
): CompiledShippingOffer[] {
  const enabledConditions = conditions.filter((condition) => condition.isEnabled);
  const cartValueCondition = enabledConditions.find(
    (condition) => condition.conditionType === "cart_value",
  );
  const cartValue = cartValueCondition
    ? normalizeConditionValue(
        cartValueCondition.conditionType,
        cartValueCondition.value as Record<string, unknown>,
      )
    : null;
  const fallbackThresholdCents = Number(cartValue?.["thresholdCents"] ?? 0);

  return rewards
    .filter((reward) => reward.rewardType === "shipping_discount")
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((reward, rewardIndex) => {
      const value = reward.value as {
        amount?: unknown;
        tiers?: Array<{
          minimumSubtotalCents?: unknown;
          discountType?: unknown;
          discountValue?: unknown;
          appliesWhen?: unknown;
        }>;
      };
      const target = reward.target as {
        deliveryGroupTypes?: unknown;
        scopeMode?: unknown;
        requiredLineAttributeValue?: unknown;
        requiredAnchorVariantIds?: unknown;
        requiredAnchorMinQuantity?: unknown;
        requiresAnchorSubscription?: unknown;
      };

      const tiers: CompiledShippingTier[] = value.tiers?.map((tier) => ({
        minimumSubtotalCents: Number(tier.minimumSubtotalCents ?? 0),
        discountType: tier.discountType === "fixed_amount" ? "fixed_amount" : "percentage",
        discountValue: Number(tier.discountValue ?? 0),
        ...(tier.appliesWhen === "has_subscription" || tier.appliesWhen === "one_time_only"
          ? { appliesWhen: tier.appliesWhen }
          : {}),
      })) ?? [{
        minimumSubtotalCents: fallbackThresholdCents,
        discountType: reward.discountType === "fixed_amount" ? "fixed_amount" : "percentage",
        discountValue: reward.discountType === "free" ? 100 : Number(value.amount ?? 0),
      }];

      const targetGroupTypes: CompiledShippingOffer["targetGroupTypes"] = Array.isArray(target.deliveryGroupTypes)
        ? target.deliveryGroupTypes.filter(
            (groupType): groupType is "ONE_TIME_PURCHASE" | "SUBSCRIPTION" =>
              groupType === "ONE_TIME_PURCHASE" || groupType === "SUBSCRIPTION",
          )
        : ["ONE_TIME_PURCHASE", "SUBSCRIPTION"];

      if (tiers.length === 0 || targetGroupTypes.length === 0) return [];

      const scopeMode = target.scopeMode === "landing" || target.scopeMode === "quiz_bundle"
        ? target.scopeMode
        : "sitewide";
      const requiredAnchorVariantIds = Array.isArray(target.requiredAnchorVariantIds)
        ? target.requiredAnchorVariantIds.filter((id): id is string => typeof id === "string")
        : [];

      return [{
        id: `${offer.id}:${reward.id}`,
        priority: offer.priority * 1000 + rewardIndex,
        tiers,
        targetGroupTypes,
        scopeMode,
        ...(scopeMode === "landing" && typeof target.requiredLineAttributeValue === "string"
          ? { requiredLineAttributeValue: target.requiredLineAttributeValue }
          : {}),
        requiredAnchorVariantIds,
        requiredAnchorMinQuantity: Math.max(1, Number(target.requiredAnchorMinQuantity ?? 1)),
        requiresAnchorSubscription: target.requiresAnchorSubscription === true,
      }];
    });
}

export function estimateConfigSize(config: CompiledFunctionConfig): number {
  return JSON.stringify(config).length;
}
