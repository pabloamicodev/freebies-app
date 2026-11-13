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
import { normalizeSubscriptionMode, withSubscriptionMode } from "./purchase-type.js";
import { splitTextareaList } from "./textarea-list.js";
import { resolveSelection } from "./whole-product-selection.server.js";
import { parseQuantityTiers, type QuantityTier } from "./quantity-tiers.js";
import type { getShopContext } from "./shop-context.server.js";

function parseShippingTiers(
  value: unknown,
): { tiers: ShippingDiscountTier[]; error?: never } | { tiers?: never; error: string } {
  if (value === undefined) return { error: "Configure at least one shipping tier." };
  const result = ShippingDiscountTierSchema.array().min(1).safeParse(value);
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? "Shipping tiers are invalid." };
  }
  return { tiers: result.data };
}

function parsePositiveIntOrUnset(raw: unknown): { value?: number; error?: true } {
  if (typeof raw === "string" ? raw.trim() === "" : typeof raw !== "number") return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: true };
  return { value: n };
}

/** Quantity tiers survive an edit of a product discount; nothing else of the old value does. */
function keptTiers(rewardType: string, existing: { rewardType: string; value: unknown } | null | undefined): { tiers?: unknown[] } {
  if (rewardType !== "product_discount" || existing?.rewardType !== "product_discount") return {};
  const tiers = (existing.value as { tiers?: unknown } | null)?.tiers;
  return Array.isArray(tiers) ? { tiers } : {};
}

type ShopDb = Awaited<ReturnType<typeof getShopContext>>["db"];

export type RewardRecordData = {
  rewardType: ReturnType<typeof RewardTypeSchema.parse>;
  discountType: ReturnType<typeof DiscountTypeSchema.parse>;
  value: Record<string, unknown>;
  target: Record<string, unknown>;
  quantity: number | null;
  isAutoAdd: boolean;
  isCustomerSelectable: boolean;
  trackMode: "product" | "variant";
  label: string | null;
  /** Gift rewards: the cart subtotal that unlocks the gift (null clears it); undefined when the input did not carry the field. */
  minCartSubtotalCents?: number | null;
};

export type RewardRecordResult = { data: RewardRecordData; error?: never } | { error: string; data?: never };

/** Marks a posted `productPriceTiers` that is not JSON, so the core reports it at the same step the form always did. */
export const INVALID_JSON = Symbol("invalidJson");

/**
 * Typed form of the reward editor's fields. Money is in major units of the shop currency. `undefined` means
 * "not provided"; numeric fields may be NaN so the same validation messages fire as for a bad form post.
 */
export type RewardInput = {
  rewardType: string;
  discountType?: string | null;
  discountValue?: number;
  quantity?: number | null;
  isAutoAdd?: boolean;
  isCustomerSelectable?: boolean;
  trackMode?: string | null;
  label?: string | null;
  currencyCode?: string | null;
  /** Gift tier unlock subtotal; null clears it, undefined keeps it. */
  minCartSubtotal?: number | null;
  /** Shipping tiers (validated with ShippingDiscountTierSchema). */
  shippingTiers?: unknown;
  /** Quantity tiers of a product discount (array or its JSON string); validated by parseQuantityTiers. */
  productTiers?: unknown;
  /** Landing price tiers, array of { quantity, targetPricePerUnit }; invalid entries are dropped. */
  productPriceTiers?: unknown;
  /** Targets picked in the product picker (gift: product or variant GIDs). */
  pickerGids?: string[];
  /** Manually typed GIDs (product discount only). */
  manualGids?: string[];
  wholeProductGids?: string[];
  fallbackVariantGids?: string[];
  deliveryGroupTypes?: unknown[];
  shippingScopeMode?: string | null;
  productScopeMode?: string | null;
  productTargetType?: string | null;
  subscriptionMode?: string | null;
  requiredLineAttributeValue?: string | null;
  requiredAnchorVariantIds?: string[];
  requiredAnchorMinQuantity?: number;
  requiresAnchorSubscription?: boolean;
  lineQuantityEquals?: number;
  maxUnitsTotal?: number | string | null;
  maxUnitsPerProduct?: number | string | null;
  maxUnitsPerLine?: number | string | null;
  maxUnitsPerVariant?: number | string | null;
  discountPercentageOnGifts?: number;
};

const formNumber = (raw: FormDataEntryValue | null): number | undefined => (raw === null ? undefined : Number(raw));

/** FormData adapter of the reward editor: reads the posted fields and calls buildRewardRecordFromInput. */
export async function buildRewardRecord(
  formData: FormData,
  db: ShopDb,
  shopId: string,
  shopCurrencyCode: string,
  existing?: { rewardType: string; value: unknown } | null,
): Promise<RewardRecordResult> {
  const parsed = rewardInputFromFormData(formData);
  if ("error" in parsed) return { error: parsed.error };
  return buildRewardRecordFromInput(parsed.input, db, shopId, shopCurrencyCode, existing);
}

/** FormData to typed input. Fails only on posted JSON that cannot be parsed. */
export function rewardInputFromFormData(formData: FormData): { input: RewardInput; error?: never } | { error: string; input?: never } {
  const rewardType = formData.get("rewardType") as string;
  let shippingTiers: unknown;
  if (rewardType === "shipping_discount") {
    const raw = formData.get("shippingTiers");
    if (typeof raw === "string") {
      try {
        shippingTiers = JSON.parse(raw);
      } catch {
        return { error: "Shipping tiers must be valid JSON." };
      }
    }
  }
  const tiersField = formData.get("productTiers");
  const rawDiscountValue = formData.get("discountValue");
  const quantityRaw = formData.get("quantity");
  const rawMinSubtotal = formData.get("minCartSubtotal");
  const list = (name: string) => splitTextareaList(formData.get(name) as string | null);
  let productPriceTiers: unknown;
  const priceTiersRaw = formData.get("productPriceTiers");
  if (typeof priceTiersRaw === "string" && priceTiersRaw) {
    try {
      productPriceTiers = JSON.parse(priceTiersRaw);
    } catch {
      productPriceTiers = INVALID_JSON;
    }
  }
  return {
    input: {
      rewardType,
      discountType: formData.get("discountType") as string | null,
      discountValue: typeof rawDiscountValue === "string" && rawDiscountValue.trim() !== "" ? Number(rawDiscountValue) : 0,
      quantity: typeof quantityRaw === "string" && quantityRaw.trim() !== "" ? Number(quantityRaw) : null,
      isAutoAdd: formData.get("isAutoAdd") === "on",
      isCustomerSelectable: formData.get("isCustomerSelectable") === "on",
      trackMode: formData.get("trackMode") as string | null,
      label: formData.get("label") as string | null,
      currencyCode: formData.get("currencyCode") as string | null,
      ...(typeof rawMinSubtotal === "string" ? { minCartSubtotal: rawMinSubtotal.trim() === "" ? null : Number(rawMinSubtotal) } : {}),
      shippingTiers,
      productTiers: typeof tiersField === "string" ? tiersField : undefined,
      productPriceTiers,
      pickerGids: list("variantGids"),
      manualGids: list("variantGidsManual"),
      wholeProductGids: list("wholeProductGids"),
      fallbackVariantGids: list("fallbackVariantGids"),
      deliveryGroupTypes: formData.getAll("deliveryGroupTypes"),
      shippingScopeMode: formData.get("shippingScopeMode") as string | null,
      productScopeMode: formData.get("productScopeMode") as string | null,
      productTargetType: formData.get("productTargetType") as string | null,
      subscriptionMode: formData.get("subscriptionMode") as string | null,
      requiredLineAttributeValue: formData.get("requiredLineAttributeValue") as string | null,
      requiredAnchorVariantIds: list("requiredAnchorVariantIds"),
      requiredAnchorMinQuantity: formNumber(formData.get("requiredAnchorMinQuantity")),
      requiresAnchorSubscription: formData.get("requiresAnchorSubscription") === "on",
      lineQuantityEquals: formNumber(formData.get("lineQuantityEquals")),
      maxUnitsTotal: formData.get("maxUnitsTotal") as string | null,
      maxUnitsPerProduct: formData.get("maxUnitsPerProduct") as string | null,
      maxUnitsPerLine: formData.get("maxUnitsPerLine") as string | null,
      maxUnitsPerVariant: formData.get("maxUnitsPerVariant") as string | null,
      discountPercentageOnGifts: formNumber(formData.get("discountPercentageOnGifts")),
    },
  };
}

/**
 * Typed core of the reward editor (admin form and MCP): validates one reward and returns the row to store.
 * Same validation, messages and stored shape the form always had.
 */
export async function buildRewardRecordFromInput(
  input: RewardInput,
  db: ShopDb,
  shopId: string,
  shopCurrencyCode: string,
  existing?: { rewardType: string; value: unknown } | null,
): Promise<RewardRecordResult> {
    const rewardType = input.rewardType;
    let discountType = input.discountType as string;
    let shippingTiers: ShippingDiscountTier[] | null = null;
    if (rewardType === "shipping_discount") {
      const parsedTiers = parseShippingTiers(input.shippingTiers);
      if ("error" in parsedTiers) return { error: parsedTiers.error ?? "Shipping tiers are invalid." };
      shippingTiers = parsedTiers.tiers;
      discountType = shippingTiers[0]!.discountType;
    }
    let postedTiers: QuantityTier[] | undefined;
    if (rewardType === "product_discount" && input.productTiers !== undefined) {
      const parsedTiers = parseQuantityTiers(input.productTiers);
      if (!parsedTiers.ok) return { error: parsedTiers.error };
      postedTiers = parsedTiers.tiers;
      if (postedTiers.length > 0) discountType = "percentage";
    }
    const rewardTypeResult = RewardTypeSchema.safeParse(rewardType);
    if (!rewardTypeResult.success) return { error: "Reward type is invalid." };
    const discountTypeResult = DiscountTypeSchema.safeParse(discountType);
    if (!discountTypeResult.success) return { error: "Discount type is invalid." };
    const discountValue = input.discountValue ?? 0;
    if (!Number.isFinite(discountValue) || discountValue < 0) {
      return { error: "Discount value must be a valid non-negative number." };
    }
    const quantity = input.quantity ?? null;
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 250)) {
      return { error: "Quantity must be a whole number between 1 and 250." };
    }
    let isAutoAdd = input.isAutoAdd === true;
    let isCustomerSelectable = input.isCustomerSelectable === true;
    let trackMode: "product" | "variant" = input.trackMode === "variant" ? "variant" : "product";
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : null;
    if (label && label.length > 120) return { error: "Reward label cannot exceed 120 characters." };
    const currencyCode = String(input.currencyCode || shopCurrencyCode)
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode))
      return { error: "Currency code must contain exactly 3 letters." };

    if (!rewardType) return { error: "Reward type is required." };

    let minCartSubtotalCents: number | null | undefined;
    if (rewardType === "product_gift" && input.minCartSubtotal !== undefined) {
      const amount = input.minCartSubtotal;
      if (amount !== null && (!Number.isFinite(amount) || amount <= 0 || toStoredAmount(amount, shopCurrencyCode) > 1_000_000_000)) {
        return { error: "Cart subtotal that unlocks this gift must be greater than 0." };
      }
      minCartSubtotalCents = amount === null ? null : toStoredAmount(amount, shopCurrencyCode);
    }

    const needsValue =
      !postedTiers?.length &&
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
    const pickerGids = input.pickerGids ?? [];
    const manualGids = input.manualGids ?? [];
    const variantGids = [...new Set([...pickerGids, ...manualGids])];

    let target: Record<string, unknown>;
    let value: Record<string, unknown>;
    if (rewardType === "shipping_discount") {
      const groupTypesResult = DeliveryGroupTypeSchema.array()
        .min(1)
        .safeParse(input.deliveryGroupTypes ?? []);
      if (!groupTypesResult.success) {
        return { error: "Choose at least one delivery group type." };
      }
      const scopeMode = input.shippingScopeMode;
      if (scopeMode !== "sitewide" && scopeMode !== "landing" && scopeMode !== "quiz_bundle") {
        return { error: "Shipping scope is invalid." };
      }
      const requiredAnchorMinQuantity = input.requiredAnchorMinQuantity ?? 1;
      target = {
        deliveryGroupTypes: groupTypesResult.data,
        scopeMode,
        ...(scopeMode === "landing"
          ? {
              requiredLineAttributeKey: "__landing_source",
              requiredLineAttributeValue: String(input.requiredLineAttributeValue ?? "").trim(),
              requiredAnchorVariantIds: input.requiredAnchorVariantIds ?? [],
              requiredAnchorMinQuantity,
              requiresAnchorSubscription: input.requiresAnchorSubscription === true,
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
        const fallbackVariantIds = (input.fallbackVariantGids ?? [])
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
        const lineQuantityEqualsRaw = input.lineQuantityEquals ?? 0;
        const subscriptionMode = input.subscriptionMode;
        const productScopeMode = input.productScopeMode;
        if (
          productScopeMode !== "sitewide" &&
          productScopeMode !== "landing" &&
          productScopeMode !== "quiz_bundle"
        ) {
          return { error: "Product discount scope is invalid." };
        }
        const productTargetType = input.productTargetType === "products" ? "products" : "variants";
        if (variantGids.length > 0) {
          if (productTargetType === "products") target = { productIds: variantGids, selectionLevel: "product" };
          else {
            // Products ticked as a whole in the variant picker go back to product ids (smaller config, same targets).
            const picked = await resolveSelection(db, shopId, variantGids, input.wholeProductGids ?? []);
            target = {
              ...(picked.productIds.length > 0 ? { productIds: picked.productIds } : {}),
              ...(picked.variantIds.length > 0 ? { variantIds: picked.variantIds } : {}),
              ...(picked.selectionLevel ? { selectionLevel: picked.selectionLevel } : {}),
            };
          }
        }
        if (productScopeMode === "landing" && variantGids.length === 0) {
          return { error: "Choose the products this landing discount applies to." };
        }
        const maxUnitsTotalField = parsePositiveIntOrUnset(input.maxUnitsTotal);
        if (maxUnitsTotalField.error)
          return { error: "Maximum discounted units in total must be a positive whole number." };
        const maxUnitsPerProductField = parsePositiveIntOrUnset(input.maxUnitsPerProduct);
        if (maxUnitsPerProductField.error)
          return { error: "Maximum discounted units per product must be a positive whole number." };
        const maxUnitsPerLineField = parsePositiveIntOrUnset(input.maxUnitsPerLine);
        if (maxUnitsPerLineField.error)
          return { error: "Maximum discounted units per line must be a positive whole number." };
        const maxUnitsPerVariantField = parsePositiveIntOrUnset(input.maxUnitsPerVariant);
        if (maxUnitsPerVariantField.error)
          return { error: "Maximum discounted units per variant must be a positive whole number." };
        let priceTiers: Array<{ quantity: number; targetPricePerUnit: number }> = [];
        const priceTiersRaw = input.productPriceTiers;
        if (priceTiersRaw === INVALID_JSON) return { error: "Product price tiers must be valid JSON." };
        if (priceTiersRaw !== undefined) {
          if (!Array.isArray(priceTiersRaw)) return { error: "Product price tiers are invalid." };
          priceTiers = priceTiersRaw.flatMap((tier) => {
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
                requiredLineAttributeValue: String(input.requiredLineAttributeValue ?? "").trim(),
                requiredAnchorVariantIds: input.requiredAnchorVariantIds ?? [],
                requiredAnchorMinQuantity: Math.max(1, input.requiredAnchorMinQuantity ?? 1),
                requiresAnchorSubscription: input.requiresAnchorSubscription === true,
                ...(priceTiers.length ? { priceTiers } : {}),
              }
            : {}),
        };
        target =
          productScopeMode === "quiz_bundle"
            ? {
                scopeMode: "quiz_bundle",
                scope: "cart",
                discountPercentageOnGifts: Math.min(100, Math.max(0, input.discountPercentageOnGifts ?? 100)),
              }
            : ordinaryTarget;
      }
      value = postedTiers?.length
        ? { amount: 0, currencyCode, tiers: postedTiers }
        : {
            ...(postedTiers ? null : keptTiers(rewardType, existing)),
            amount: discountType === "percentage" ? discountValue : toStoredAmount(discountValue, shopCurrencyCode),
            currencyCode,
          };
    }
    if (rewardType === "order_discount") {
      target = withSubscriptionMode({ ...target }, normalizeSubscriptionMode(input.subscriptionMode ?? null));
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
        ...(minCartSubtotalCents !== undefined ? { minCartSubtotalCents } : {}),
      },
    };
}
