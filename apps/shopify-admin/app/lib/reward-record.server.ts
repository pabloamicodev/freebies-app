import { productCache, variantCache } from "@promo/db";
import {
  DeliveryGroupTypeSchema,
  DiscountTypeSchema,
  RewardTypeSchema,
  ShippingDiscountTierSchema,
  validateRewardPayload,
  type ShippingDiscountTier,
} from "@promo/shared-types";
import { and, eq, inArray } from "drizzle-orm";
import { toStoredAmount } from "./money.js";
import { parseSubscriptionMode, withSubscriptionMode } from "./purchase-type.js";
import { splitTextareaList } from "./textarea-list.js";
import type { getShopContext } from "./shop-context.server.js";

function parseShippingTiers(
  value: FormDataEntryValue | null,
): { tiers: ShippingDiscountTier[]; error?: never } | { tiers?: never; error: string } {
  if (typeof value !== "string") return { error: "Configure at least one shipping tier." };
  try {
    const result = ShippingDiscountTierSchema.array().min(1).safeParse(JSON.parse(value));
    if (!result.success) {
      return { error: result.error.issues[0]?.message ?? "Shipping tiers are invalid." };
    }
    return { tiers: result.data };
  } catch {
    return { error: "Shipping tiers must be valid JSON." };
  }
}

function parsePositiveIntOrUnset(raw: FormDataEntryValue | null): { value?: number; error?: true } {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: true };
  return { value: n };
}

type ShopDb = Awaited<ReturnType<typeof getShopContext>>["db"];

export async function buildRewardRecord(
  formData: FormData,
  db: ShopDb,
  shopId: string,
  shopCurrencyCode: string,
): Promise<
  | {
      data: {
        rewardType: ReturnType<typeof RewardTypeSchema.parse>;
        discountType: ReturnType<typeof DiscountTypeSchema.parse>;
        value: Record<string, unknown>;
        target: Record<string, unknown>;
        quantity: number | null;
        isAutoAdd: boolean;
        isCustomerSelectable: boolean;
        trackMode: "product" | "variant";
        label: string | null;
      };
      error?: never;
    }
  | { error: string; data?: never }
> {
    const rewardType = formData.get("rewardType") as string;
    let discountType = formData.get("discountType") as string;
    let shippingTiers: ShippingDiscountTier[] | null = null;
    if (rewardType === "shipping_discount") {
      const parsedTiers = parseShippingTiers(formData.get("shippingTiers"));
      if ("error" in parsedTiers) return { error: parsedTiers.error ?? "Shipping tiers are invalid." };
      shippingTiers = parsedTiers.tiers;
      discountType = shippingTiers[0]!.discountType;
    }
    const rewardTypeResult = RewardTypeSchema.safeParse(rewardType);
    if (!rewardTypeResult.success) return { error: "Reward type is invalid." };
    const discountTypeResult = DiscountTypeSchema.safeParse(discountType);
    if (!discountTypeResult.success) return { error: "Discount type is invalid." };
    const rawDiscountValue = formData.get("discountValue");
    const discountValue =
      typeof rawDiscountValue === "string" && rawDiscountValue.trim() !== ""
        ? Number(rawDiscountValue)
        : 0;
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      return { error: "Discount value must be a valid non-negative number." };
    }
    const quantityRaw = formData.get("quantity");
    const quantity =
      typeof quantityRaw === "string" && quantityRaw.trim() !== "" ? Number(quantityRaw) : null;
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 250)) {
      return { error: "Quantity must be a whole number between 1 and 250." };
    }
    let isAutoAdd = formData.get("isAutoAdd") === "on";
    let isCustomerSelectable = formData.get("isCustomerSelectable") === "on";
    const requestedTrackMode = formData.get("trackMode");
    let trackMode: "product" | "variant" = requestedTrackMode === "variant" ? "variant" : "product";
    const rawLabel = formData.get("label");
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : null;
    if (label && label.length > 120) return { error: "Reward label cannot exceed 120 characters." };
    const currencyCode = String(formData.get("currencyCode") || shopCurrencyCode)
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode))
      return { error: "Currency code must contain exactly 3 letters." };

    if (!rewardType) return { error: "Reward type is required." };

    const needsValue =
      rewardType !== "shipping_discount" &&
      discountType !== "free" &&
      discountType !== "cheapest_item_free";
    if (needsValue && discountValue <= 0) {
      return { error: "Discount value must be greater than 0." };
    }
    if ((discountType === "percentage" || discountType === "most_expensive_item_discount") && discountValue > 100) {
      return { error: "Percentage discount cannot exceed 100%." };
    }

    // Product discounts retain the advanced variant/manual controls. Gifts are
    // product-based and resolved server-side so auto-add vs. customer choice
    // can never be saved in a contradictory state.
    const pickerGids = splitTextareaList(formData.get("variantGids") as string | null);
    const manualGids = splitTextareaList(formData.get("variantGidsManual") as string | null);
    const variantGids = [...new Set([...pickerGids, ...manualGids])];

    let target: Record<string, unknown>;
    let value: Record<string, unknown>;
    if (rewardType === "shipping_discount") {
      const groupTypesResult = DeliveryGroupTypeSchema.array()
        .min(1)
        .safeParse(formData.getAll("deliveryGroupTypes"));
      if (!groupTypesResult.success) {
        return { error: "Choose at least one delivery group type." };
      }
      const scopeMode = formData.get("shippingScopeMode");
      if (scopeMode !== "sitewide" && scopeMode !== "landing" && scopeMode !== "quiz_bundle") {
        return { error: "Shipping scope is invalid." };
      }
      const requiredAnchorMinQuantity = Number(formData.get("requiredAnchorMinQuantity") ?? 1);
      target = {
        deliveryGroupTypes: groupTypesResult.data,
        scopeMode,
        ...(scopeMode === "landing"
          ? {
              requiredLineAttributeKey: "__landing_source",
              requiredLineAttributeValue: String(
                formData.get("requiredLineAttributeValue") ?? "",
              ).trim(),
              requiredAnchorVariantIds: splitTextareaList(
                formData.get("requiredAnchorVariantIds") as string | null,
              ),
              requiredAnchorMinQuantity,
              requiresAnchorSubscription: formData.get("requiresAnchorSubscription") === "on",
            }
          : {}),
      };
      value = {
        amount: shippingTiers![0]!.discountValue,
        currencyCode,
        tiers: shippingTiers,
      };
    } else {
      if (rewardType === "product_gift") {
        const pickedGids = [...new Set(pickerGids)];
        const pickedVariantGids = pickedGids.filter((gid) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(gid));
        const productGids = pickedGids.filter((gid) => !pickedVariantGids.includes(gid));
        if (pickedVariantGids.length > 0) {
          // A variant subset: derive the parent product from the cached variants.
          const owners = await db
            .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
            .from(variantCache)
            .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, pickedVariantGids)));
          if (owners.length !== pickedVariantGids.length) {
            return { error: "One or more selected gift variants were not found in the catalog." };
          }
          for (const owner of owners) if (!productGids.includes(owner.productGid)) productGids.push(owner.productGid);
        }
        const chosenVariantGids = pickedVariantGids;
        if (productGids.length !== 1 || !/^gid:\/\/shopify\/Product\/\d+$/.test(productGids[0]!)) {
          return { error: "Choose exactly one Shopify product for this gift reward." };
        }
        const productGid = productGids[0]!;
        const [productRows, candidateVariants] = await Promise.all([
          db
            .select({ status: productCache.status })
            .from(productCache)
            .where(and(eq(productCache.shopId, shopId), eq(productCache.productGid, productGid)))
            .limit(1),
          db
            .select({
              variantGid: variantCache.variantGid,
              availableForSale: variantCache.availableForSale,
              inventoryQuantity: variantCache.inventoryQuantity,
              inventoryPolicy: variantCache.inventoryPolicy,
              requiresSellingPlan: variantCache.requiresSellingPlan,
            })
            .from(variantCache)
            .where(and(eq(variantCache.shopId, shopId), eq(variantCache.productGid, productGid))),
        ]);
        if (!productRows[0] || productRows[0].status !== "ACTIVE") {
          return { error: "The selected gift product must be active in Shopify." };
        }
        const eligibleVariantIds = candidateVariants
          .filter((variant) => chosenVariantGids.length === 0 || chosenVariantGids.includes(variant.variantGid))
          // Sold-out variants are kept on purpose: the storefront shows them as sold out and they join the gift once restocked.
          .filter((variant) => !variant.requiresSellingPlan)
          .map((variant) => variant.variantGid);
        if (eligibleVariantIds.length === 0) {
          return { error: "The selected product has no one-time-purchase variants." };
        }
        if (eligibleVariantIds.length > 1 && (quantity ?? 1) > eligibleVariantIds.length) {
          return {
            error: `Gift quantity cannot exceed the ${eligibleVariantIds.length} available variants.`,
          };
        }
        const fallbackVariantIds = splitTextareaList(formData.get("fallbackVariantGids") as string | null)
          .filter((gid) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(gid) && !eligibleVariantIds.includes(gid))
          .slice(0, 5);
        target = {
          productId: productGid,
          variantIds: eligibleVariantIds,
          ...(fallbackVariantIds.length > 0 ? { fallbackVariantIds } : {}),
        };
        isAutoAdd = eligibleVariantIds.length === 1;
        isCustomerSelectable = eligibleVariantIds.length > 1;
        trackMode = eligibleVariantIds.length === 1 ? "variant" : "product";
      } else {
        target = variantGids.length > 0 ? { variantIds: variantGids } : { scope: "cart" };
      }
      if (rewardType === "product_discount") {
        const lineQuantityEqualsRaw = Number(formData.get("lineQuantityEquals") ?? 0);
        const subscriptionMode = formData.get("subscriptionMode");
        const productScopeMode = formData.get("productScopeMode");
        if (
          productScopeMode !== "sitewide" &&
          productScopeMode !== "landing" &&
          productScopeMode !== "quiz_bundle"
        ) {
          return { error: "Product discount scope is invalid." };
        }
        const productTargetType = formData.get("productTargetType") === "products" ? "products" : "variants";
        if (variantGids.length > 0) {
          target = productTargetType === "products" ? { productIds: variantGids } : { variantIds: variantGids };
        }
        if (productScopeMode === "landing" && variantGids.length === 0) {
          return { error: "Choose the products this landing discount applies to." };
        }
        const maxUnitsTotalField = parsePositiveIntOrUnset(formData.get("maxUnitsTotal"));
        if (maxUnitsTotalField.error)
          return { error: "Maximum discounted units in total must be a positive whole number." };
        const maxUnitsPerProductField = parsePositiveIntOrUnset(formData.get("maxUnitsPerProduct"));
        if (maxUnitsPerProductField.error)
          return { error: "Maximum discounted units per product must be a positive whole number." };
        const maxUnitsPerLineField = parsePositiveIntOrUnset(formData.get("maxUnitsPerLine"));
        if (maxUnitsPerLineField.error)
          return { error: "Maximum discounted units per line must be a positive whole number." };
        const maxUnitsPerVariantField = parsePositiveIntOrUnset(formData.get("maxUnitsPerVariant"));
        if (maxUnitsPerVariantField.error)
          return { error: "Maximum discounted units per variant must be a positive whole number." };
        let priceTiers: Array<{ quantity: number; targetPricePerUnit: number }> = [];
        const priceTiersRaw = formData.get("productPriceTiers");
        if (typeof priceTiersRaw === "string" && priceTiersRaw) {
          try {
            const parsed = JSON.parse(priceTiersRaw) as unknown;
            if (!Array.isArray(parsed)) return { error: "Product price tiers are invalid." };
            priceTiers = parsed.flatMap((tier) => {
              if (!tier || typeof tier !== "object") return [];
              const candidate = tier as Record<string, unknown>;
              const tierQuantity = Number(candidate["quantity"]);
              const targetPricePerUnit = Number(candidate["targetPricePerUnit"]);
              return Number.isInteger(tierQuantity) &&
                tierQuantity > 0 &&
                Number.isFinite(targetPricePerUnit) &&
                targetPricePerUnit >= 0
                ? [{ quantity: tierQuantity, targetPricePerUnit }]
                : [];
            });
          } catch {
            return { error: "Product price tiers must be valid JSON." };
          }
        }
        const ordinaryTarget = {
          ...target,
          ...(Number.isInteger(lineQuantityEqualsRaw) && lineQuantityEqualsRaw > 0
            ? { lineQuantityEquals: lineQuantityEqualsRaw }
            : {}),
          ...(maxUnitsTotalField.value !== undefined ? { maxUnitsTotal: maxUnitsTotalField.value } : {}),
          ...(maxUnitsPerProductField.value !== undefined
            ? { maxUnitsPerProduct: maxUnitsPerProductField.value }
            : {}),
          ...(maxUnitsPerLineField.value !== undefined
            ? { maxUnitsPerLine: maxUnitsPerLineField.value }
            : {}),
          ...(maxUnitsPerVariantField.value !== undefined
            ? { maxUnitsPerVariant: maxUnitsPerVariantField.value }
            : {}),
          subscriptionMode:
            subscriptionMode === "subscription_only" || subscriptionMode === "one_time_only"
              ? subscriptionMode
              : "any",
          scopeMode: productScopeMode,
          ...(productScopeMode === "landing"
            ? {
                requiredLineAttributeKey: "__landing_source",
                requiredLineAttributeValue: String(
                  formData.get("requiredLineAttributeValue") ?? "",
                ).trim(),
                requiredAnchorVariantIds: splitTextareaList(
                  formData.get("requiredAnchorVariantIds") as string | null,
                ),
                requiredAnchorMinQuantity: Math.max(
                  1,
                  Number(formData.get("requiredAnchorMinQuantity") ?? 1),
                ),
                requiresAnchorSubscription: formData.get("requiresAnchorSubscription") === "on",
                ...(priceTiers.length ? { priceTiers } : {}),
              }
            : {}),
        };
        target =
          productScopeMode === "quiz_bundle"
            ? {
                scopeMode: "quiz_bundle",
                scope: "cart",
                discountPercentageOnGifts: Math.min(
                  100,
                  Math.max(0, Number(formData.get("discountPercentageOnGifts") ?? 100)),
                ),
              }
            : ordinaryTarget;
      }
      value = {
        amount: discountType === "percentage" ? discountValue : toStoredAmount(discountValue, currencyCode),
        currencyCode,
      };
    }
    if (rewardType === "order_discount") {
      target = withSubscriptionMode({ ...target }, parseSubscriptionMode(formData));
    }
    const payloadResult = validateRewardPayload(rewardType, discountType, value, target);
    if (!payloadResult.success)
      return {
        error: payloadResult.error.issues[0]?.message ?? "Reward configuration is invalid.",
      };

    return {
      data: {
        rewardType: rewardTypeResult.data,
        discountType: discountTypeResult.data,
        value,
        target,
        quantity,
        isAutoAdd,
        isCustomerSelectable,
        trackMode,
        label,
      },
    };
}
