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
  c1?: string;
  c2?: string;
  c3?: string;
  customerTags?: string[];
}

export interface CompiledShippingTier {
  minimumSubtotalCents: number;
  maximumSubtotalCents?: number;
  discountType: "percentage" | "fixed_amount";
  discountValue: number;
  appliesWhen?: "has_subscription" | "one_time_only";
}

export interface CompiledShippingOffer {
  id: string;
  /** Customer-facing shipping discount name, emitted as the candidate message. */
  title?: string;
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
  /** Customer-facing discount name shown in cart and checkout. */
  title?: string;
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
  pageUrlConditions?: CompiledPageUrlCondition[];
}

export interface CompiledAttributeCondition {
  key: string;
  value: string;
  matchMode: "equals" | "not_equals";
  minMatchingQuantity: number;
}

export interface CompiledPageUrlCondition {
  patterns: string[];
  matchMode: "exact" | "contains" | "starts_with" | "ends_with";
  caseSensitive: boolean;
  paramName?: string;
  paramValue?: string;
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
  /** Caps discounted units of each target product (e.g. one free unit per gift product). */
  maxUnitsPerProduct?: number;
  /** Caps discounted units within a single cart line, independent of other lines. */
  maxUnitsPerLine?: number;
  /** Caps discounted units of each target variant, accumulated across lines. */
  maxUnitsPerVariant?: number;
  subscriptionMode: "any" | "subscription_only" | "one_time_only";
  scopeMode: "sitewide" | "landing" | "quiz_bundle" | "tagged_offer";
  requiredOfferId?: string;
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds: string[];
  requiredAnchorMinQuantity: number;
  requiresAnchorSubscription: boolean;
  priceTiers: Array<{ quantity: number; targetPricePerUnit: number }>;
  quantityTiers: CompiledProductDiscountTier[];
  selectionMode: "all" | "cheapest" | "most_expensive";
  countRule: "all" | "unique";
  discountPercentageOnGifts: number;
}

export interface CompiledProductDiscountTier {
  minimumQuantity: number;
  maximumQuantity?: number;
  discountType: "percentage" | "fixed_amount" | "fixed_price" | "free";
  discountValue: number;
  discountedQuantity?: number;
}

export interface CompiledOrderReward {
  id: string;
  discountType: "percentage" | "fixed_amount" | "free";
  discountValue: number;
  subtotalTiers: CompiledSubtotalDiscountTier[];
}

export interface CompiledSubtotalDiscountTier {
  minimumSubtotalCents?: number;
  maximumSubtotalCents?: number;
  minimumQuantity?: number;
  maximumQuantity?: number;
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
    title: offer.publicTitle?.trim() || undefined,
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
    pageUrlConditions: [],
  };

  for (const cond of conditions.filter(
    (candidate) => candidate.isEnabled && (candidate.scope === "main" || candidate.scope === "sub"),
  )) {
    const value = normalizeConditionValue(
      cond.conditionType,
      cond.value as Record<string, unknown>,
    );
    switch (cond.conditionType) {
      case "cart_value": {
        config.cartValueThresholdCents = Number(value["thresholdCents"] ?? 0);
        if (Number(value["maxCents"] ?? 0) > 0)
          config.cartValueMaxCents = Number(value["maxCents"]);
        if (value["currencyOverrides"])
          config.currencyOverrides = value["currencyOverrides"] as Record<string, number>;
        if (value["maxCurrencyOverrides"])
          config.maxCurrencyOverrides = value["maxCurrencyOverrides"] as Record<string, number>;
        const filter = value["scopeFilter"] as Record<string, string[]> | undefined;
        if (filter?.excludeProductIds) config.excludedProductIds.push(...filter.excludeProductIds);
        break;
      }
      case "cart_quantity":
        config.cartQuantityThreshold = Number(value["minQuantity"] ?? 0);
        if (Number(value["maxQuantity"] ?? 0) > 0)
          config.cartQuantityMax = Number(value["maxQuantity"]);
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
        applyIntegerBounds(
          config,
          "customerOrderCountMin",
          "customerOrderCountMax",
          cond.operator,
          threshold,
        );
        break;
      }
      case "order_history_total_spent": {
        const threshold = Math.max(0, Number(value["valueCents"] ?? 0));
        applyIntegerBounds(
          config,
          "customerAmountSpentMinCents",
          "customerAmountSpentMaxCents",
          cond.operator,
          threshold,
        );
        break;
      }
      case "specific_product": {
        const reqs =
          (value["requirements"] as Array<{
            productId?: string;
            variantId?: string;
            trackMode?: string;
            minQuantity?: number;
            maxQuantity?: number;
          }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId)
            config.requiredVariantIds.push(req.variantId);
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
        const reqs =
          (value["requirements"] as Array<{
            productId?: string;
            variantId?: string;
            trackMode?: string;
            quantityPerPack?: number;
          }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId)
            config.requiredVariantIds.push(req.variantId);
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
          ? value["includeCountryCodes"]
              .filter((code): code is string => typeof code === "string")
              .map((code) => code.toUpperCase())
          : [];
        config.excludeCountryCodes = Array.isArray(value["excludeCountryCodes"])
          ? value["excludeCountryCodes"]
              .filter((code): code is string => typeof code === "string")
              .map((code) => code.toUpperCase())
          : [];
        break;
      case "specific_link": {
        const requiredUrl = String(value["requiredUrl"] ?? "").trim();
        let requiredPath = requiredUrl.split("?")[0] ?? "";
        try {
          requiredPath = new URL(requiredUrl).pathname;
        } catch {
          // Relative paths are already in the representation stamped by the storefront.
        }
        config.pageUrlConditions!.push({
          patterns: requiredPath ? [requiredPath] : [],
          matchMode: "contains",
          caseSensitive: false,
          ...(typeof value["paramName"] === "string"
            ? { paramName: encodeURIComponent(value["paramName"]) }
            : {}),
          ...(typeof value["paramValue"] === "string"
            ? { paramValue: encodeURIComponent(value["paramValue"]) }
            : {}),
        });
        break;
      }
      case "page_url":
        config.pageUrlConditions!.push({
          patterns: Array.isArray(value["patterns"])
            ? value["patterns"].filter((pattern): pattern is string => typeof pattern === "string")
            : [],
          matchMode:
            value["matchMode"] === "exact" ||
            value["matchMode"] === "starts_with" ||
            value["matchMode"] === "ends_with"
              ? value["matchMode"]
              : "contains",
          caseSensitive: value["caseSensitive"] === true,
        });
        break;
    }
  }

  for (const reward of rewards) {
    const target = reward.target as Record<string, unknown>;
    const value = reward.value as Record<string, unknown>;
    if (reward.rewardType === "product_gift") {
      const fallbackVariantIds = Array.isArray(target["fallbackVariantIds"])
        ? (target["fallbackVariantIds"] as string[])
        : [];
      // Fallback variants must be accepted by the Function and cart validation when the
      // storefront swaps them in for a sold-out gift.
      const variantIds = [
        ...((target["variantIds"] as string[]) ??
          (target["variantId"] ? [target["variantId"] as string] : [])),
        ...fallbackVariantIds,
      ];
      const productIds =
        (target["productIds"] as string[]) ??
        (target["productId"] ? [target["productId"] as string] : []);
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
      const configuredAmount = Number(value["amount"] ?? 0);
      const hasConfiguredTiers =
        (Array.isArray(value["tiers"]) && value["tiers"].length > 0) ||
        (Array.isArray(target["priceTiers"]) && target["priceTiers"].length > 0);
      if (reward.rewardType === "upsell_discount" && configuredAmount <= 0 && !hasConfiguredTiers) {
        continue;
      }
      const targetVariantIds =
        (target["variantIds"] as string[]) ??
        (target["variantId"] ? [target["variantId"] as string] : []);
      const targetProductIds =
        (target["productIds"] as string[]) ??
        (target["productId"] ? [target["productId"] as string] : []);
      const currencyCode = String(value["currencyCode"] ?? "USD");
      config.productRewards.push({
        id: reward.id,
        targetProductIds,
        targetVariantIds,
        discountType: reward.discountType,
        discountValue: functionDiscountValue(reward.discountType, configuredAmount, currencyCode),
        ...(reward.quantity ? { maxQuantity: reward.quantity } : {}),
        ...(Number.isInteger(target["lineQuantityEquals"])
          ? { lineQuantityEquals: Number(target["lineQuantityEquals"]) }
          : {}),
        ...(Number.isInteger(target["maxUnitsTotal"])
          ? { maxUnitsTotal: Number(target["maxUnitsTotal"]) }
          : {}),
        ...(Number.isInteger(target["maxUnitsPerProduct"])
          ? { maxUnitsPerProduct: Number(target["maxUnitsPerProduct"]) }
          : {}),
        ...(Number.isInteger(target["maxUnitsPerLine"])
          ? { maxUnitsPerLine: Number(target["maxUnitsPerLine"]) }
          : {}),
        ...(Number.isInteger(target["maxUnitsPerVariant"])
          ? { maxUnitsPerVariant: Number(target["maxUnitsPerVariant"]) }
          : {}),
        subscriptionMode:
          target["subscriptionMode"] === "subscription_only" ||
          target["subscriptionMode"] === "one_time_only"
            ? target["subscriptionMode"]
            : "any",
        scopeMode:
          target["scopeMode"] === "landing" ||
          target["scopeMode"] === "quiz_bundle" ||
          target["scopeMode"] === "tagged_offer"
            ? target["scopeMode"]
            : "sitewide",
        ...(typeof target["requiredOfferId"] === "string"
          ? { requiredOfferId: target["requiredOfferId"] }
          : {}),
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
              return Number.isInteger(quantity) &&
                quantity > 0 &&
                Number.isFinite(targetPricePerUnit) &&
                targetPricePerUnit >= 0
                ? [{ quantity, targetPricePerUnit }]
                : [];
            })
          : [],
        quantityTiers: Array.isArray(value["tiers"])
          ? value["tiers"].flatMap((tier) => {
              if (!tier || typeof tier !== "object") return [];
              const candidate = tier as Record<string, unknown>;
              const minimumQuantity = Number(candidate["minimumQuantity"]);
              const maximumQuantity =
                candidate["maximumQuantity"] === undefined
                  ? undefined
                  : Number(candidate["maximumQuantity"]);
              const discountValue = Number(candidate["discountValue"]);
              const discountType = candidate["discountType"];
              if (
                !Number.isInteger(minimumQuantity) ||
                minimumQuantity < 1 ||
                !Number.isFinite(discountValue) ||
                discountValue < 0
              )
                return [];
              if (
                maximumQuantity !== undefined &&
                (!Number.isInteger(maximumQuantity) || maximumQuantity < minimumQuantity)
              )
                return [];
              if (
                discountType !== "percentage" &&
                discountType !== "fixed_amount" &&
                discountType !== "fixed_price" &&
                discountType !== "free"
              )
                return [];
              const discountedQuantity =
                candidate["discountedQuantity"] === undefined
                  ? undefined
                  : Number(candidate["discountedQuantity"]);
              if (
                discountedQuantity !== undefined &&
                (!Number.isInteger(discountedQuantity) || discountedQuantity < 1)
              )
                return [];
              return [
                {
                  minimumQuantity,
                  ...(maximumQuantity === undefined ? {} : { maximumQuantity }),
                  discountType,
                  discountValue,
                  ...(discountedQuantity === undefined ? {} : { discountedQuantity }),
                },
              ];
            })
          : [],
        selectionMode:
          target["selectionMode"] === "cheapest" || target["selectionMode"] === "most_expensive"
            ? target["selectionMode"]
            : "all",
        countRule: target["countRule"] === "unique" ? "unique" : "all",
        discountPercentageOnGifts: Math.min(
          100,
          Math.max(0, Number(target["discountPercentageOnGifts"] ?? 100)),
        ),
      });
    }
    if (reward.rewardType === "order_discount") {
      const currencyCode = String(value["currencyCode"] ?? "USD");
      const discountType =
        reward.discountType === "fixed_amount"
          ? "fixed_amount"
          : reward.discountType === "free"
            ? "free"
            : "percentage";
      config.orderRewards.push({
        id: reward.id,
        discountType,
        discountValue: functionDiscountValue(
          discountType,
          Number(value["amount"] ?? 0),
          currencyCode,
        ),
        subtotalTiers: Array.isArray(value["tiers"])
          ? value["tiers"].flatMap((tier) => {
              if (!tier || typeof tier !== "object") return [];
              const candidate = tier as Record<string, unknown>;
              const minimumSubtotalCents =
                candidate["minimumSubtotalCents"] === undefined
                  ? undefined
                  : Number(candidate["minimumSubtotalCents"]);
              const maximumSubtotalCents =
                candidate["maximumSubtotalCents"] === undefined
                  ? undefined
                  : Number(candidate["maximumSubtotalCents"]);
              const minimumQuantity =
                candidate["minimumQuantity"] === undefined
                  ? undefined
                  : Number(candidate["minimumQuantity"]);
              const maximumQuantity =
                candidate["maximumQuantity"] === undefined
                  ? undefined
                  : Number(candidate["maximumQuantity"]);
              const discountValue = Number(candidate["discountValue"]);
              const tierDiscountType = candidate["discountType"];
              const hasSubtotalBounds = minimumSubtotalCents !== undefined;
              const hasQuantityBounds = minimumQuantity !== undefined;
              if (
                hasSubtotalBounds === hasQuantityBounds ||
                !Number.isFinite(discountValue) ||
                discountValue < 0
              )
                return [];
              if (
                minimumSubtotalCents !== undefined &&
                (!Number.isInteger(minimumSubtotalCents) || minimumSubtotalCents < 0)
              )
                return [];
              if (
                minimumQuantity !== undefined &&
                (!Number.isInteger(minimumQuantity) || minimumQuantity < 1)
              )
                return [];
              if (
                maximumSubtotalCents !== undefined &&
                (!Number.isInteger(maximumSubtotalCents) ||
                  maximumSubtotalCents < (minimumSubtotalCents ?? 0))
              )
                return [];
              if (
                maximumQuantity !== undefined &&
                (!Number.isInteger(maximumQuantity) || maximumQuantity < (minimumQuantity ?? 1))
              )
                return [];
              if (
                tierDiscountType !== "percentage" &&
                tierDiscountType !== "fixed_amount" &&
                tierDiscountType !== "free"
              )
                return [];
              return [
                {
                  ...(minimumSubtotalCents === undefined ? {} : { minimumSubtotalCents }),
                  ...(maximumSubtotalCents === undefined ? {} : { maximumSubtotalCents }),
                  ...(minimumQuantity === undefined ? {} : { minimumQuantity }),
                  ...(maximumQuantity === undefined ? {} : { maximumQuantity }),
                  discountType: tierDiscountType,
                  discountValue,
                },
              ];
            })
          : [],
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

function functionDiscountValue(
  discountType: string,
  storedAmount: number,
  currencyCode: string,
): number {
  if (discountType === "free") return 100;
  // most_expensive_item_discount is a percentage off the priciest eligible item.
  if (discountType === "percentage" || discountType === "most_expensive_item_discount") return storedAmount;
  const zeroDecimalCurrencies = new Set([
    "JPY",
    "KRW",
    "VND",
    "BIF",
    "CLP",
    "GNF",
    "ISK",
    "KMF",
    "MGA",
    "DJF",
    "PYG",
    "RWF",
    "UGX",
    "VUV",
    "XAF",
    "XOF",
    "XPF",
  ]);
  return zeroDecimalCurrencies.has(currencyCode.toUpperCase()) ? storedAmount : storedAmount / 100;
}

export function compileShippingOfferConfigs(
  offer: OfferRow,
  conditions: ConditionRow[],
  rewards: RewardRow[],
): CompiledShippingOffer[] {
  const enabledConditions = conditions.filter(
    (condition) => condition.isEnabled && (condition.scope === "main" || condition.scope === "sub"),
  );
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
          maximumSubtotalCents?: unknown;
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
        ...(tier.maximumSubtotalCents === undefined
          ? {}
          : { maximumSubtotalCents: Number(tier.maximumSubtotalCents) }),
        discountType: tier.discountType === "fixed_amount" ? "fixed_amount" : "percentage",
        discountValue: Number(tier.discountValue ?? 0),
        ...(tier.appliesWhen === "has_subscription" || tier.appliesWhen === "one_time_only"
          ? { appliesWhen: tier.appliesWhen }
          : {}),
      })) ?? [
        {
          minimumSubtotalCents: fallbackThresholdCents,
          discountType: reward.discountType === "fixed_amount" ? "fixed_amount" : "percentage",
          discountValue: reward.discountType === "free" ? 100 : Number(value.amount ?? 0),
        },
      ];

      const targetGroupTypes: CompiledShippingOffer["targetGroupTypes"] = Array.isArray(
        target.deliveryGroupTypes,
      )
        ? target.deliveryGroupTypes.filter(
            (groupType): groupType is "ONE_TIME_PURCHASE" | "SUBSCRIPTION" =>
              groupType === "ONE_TIME_PURCHASE" || groupType === "SUBSCRIPTION",
          )
        : ["ONE_TIME_PURCHASE", "SUBSCRIPTION"];

      if (tiers.length === 0 || targetGroupTypes.length === 0) return [];

      const scopeMode =
        target.scopeMode === "landing" || target.scopeMode === "quiz_bundle"
          ? target.scopeMode
          : "sitewide";
      const requiredAnchorVariantIds = Array.isArray(target.requiredAnchorVariantIds)
        ? target.requiredAnchorVariantIds.filter((id): id is string => typeof id === "string")
        : [];

      return [
        {
          id: `${offer.id}:${reward.id}`,
          title: offer.publicTitle?.trim() || undefined,
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
        },
      ];
    });
}

// Each table mirrors the serde defaults of the matching struct in
// extensions/discount-function/src/config.rs and
// extensions/delivery-discount-function/src/config.rs. A key is omitted only
// when the Function would deserialize exactly this value without it.
type FieldDefaults = Readonly<Record<string, unknown>>;

const CONFIG_DEFAULTS: FieldDefaults = { shippingOffers: [] };

// The metafield doubles as the Function's input-query variables. Shopify passes null for any
// declared variable missing from it (query defaults are ignored), and the query declares them
// non-null, so every run fails before executing unless all of them are present.
export const FUNCTION_QUERY_VARIABLE_DEFAULTS = {
  c1: "_promo_engine_unused",
  c2: "_promo_engine_unused",
  c3: "_promo_engine_unused",
  customerTags: [] as string[],
};
const OFFER_DEFAULTS: FieldDefaults = {
  stopLowerPriority: false,
  requiredProductIds: [],
  requiredVariantIds: [],
  excludedProductIds: [],
  giftVariantIds: [],
  giftProductIds: [],
  requiredCustomerTags: [],
  excludedCustomerTags: [],
  treatGuestAsNoTags: true,
  includeCountryCodes: [],
  excludeCountryCodes: [],
  discountType: "free",
  discountValue: 100,
  currencyCode: "USD",
  requirements: [],
  giftRewards: [],
  productRewards: [],
  orderRewards: [],
  lineAttributeConditions: [],
  cartAttributeConditions: [],
  pageUrlConditions: [],
};
// Combination policy is applied to the discount node, never read by a Function.
const OFFER_UNREAD_KEYS = [
  "combinesWithOrderDiscounts",
  "combinesWithShippingDiscounts",
  "combinesWithProductDiscounts",
];
const GIFT_REWARD_DEFAULTS: FieldDefaults = { targetProductIds: [], targetVariantIds: [] };
const PRODUCT_REWARD_DEFAULTS: FieldDefaults = {
  targetProductIds: [],
  targetVariantIds: [],
  subscriptionMode: "any",
  scopeMode: "sitewide",
  requiredAnchorVariantIds: [],
  requiredAnchorMinQuantity: 1,
  requiresAnchorSubscription: false,
  priceTiers: [],
  quantityTiers: [],
  selectionMode: "all",
  countRule: "all",
  discountPercentageOnGifts: 100,
};
const ORDER_REWARD_DEFAULTS: FieldDefaults = { subtotalTiers: [] };
const PAGE_URL_CONDITION_DEFAULTS: FieldDefaults = { patterns: [], caseSensitive: false };
const SHIPPING_OFFER_DEFAULTS: FieldDefaults = {
  scopeMode: "sitewide",
  requiredAnchorVariantIds: [],
  requiredAnchorMinQuantity: 1,
  requiresAnchorSubscription: false,
};

function omitDefaults(
  value: object,
  defaults: FieldDefaults,
  unread: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => {
      if (entry === undefined || unread.includes(key)) return false;
      if (!(key in defaults)) return true;
      const fallback = defaults[key];
      return Array.isArray(fallback)
        ? !(Array.isArray(entry) && entry.length === 0)
        : entry !== fallback;
    }),
  );
}

export function compactCompiledOffer(offer: CompiledOffer): Record<string, unknown> {
  return omitDefaults(
    {
      ...offer,
      giftRewards: offer.giftRewards.map((reward) => omitDefaults(reward, GIFT_REWARD_DEFAULTS)),
      productRewards: offer.productRewards.map((reward) =>
        omitDefaults(reward, PRODUCT_REWARD_DEFAULTS),
      ),
      orderRewards: offer.orderRewards.map((reward) => omitDefaults(reward, ORDER_REWARD_DEFAULTS)),
      pageUrlConditions: offer.pageUrlConditions?.map((condition) =>
        omitDefaults(condition, PAGE_URL_CONDITION_DEFAULTS),
      ),
    },
    OFFER_DEFAULTS,
    OFFER_UNREAD_KEYS,
  );
}

/** The metafield value: Function metafield input is capped at 10,000 bytes. */
export function serializeFunctionConfig(config: CompiledFunctionConfig): string {
  return JSON.stringify(
    omitDefaults(
      {
        ...FUNCTION_QUERY_VARIABLE_DEFAULTS,
        ...config,
        offers: config.offers.map(compactCompiledOffer),
        shippingOffers: config.shippingOffers.map((offer) =>
          omitDefaults(offer, SHIPPING_OFFER_DEFAULTS),
        ),
      },
      CONFIG_DEFAULTS,
    ),
  );
}
