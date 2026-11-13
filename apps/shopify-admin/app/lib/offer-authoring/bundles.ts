import { z } from "zod";
import {
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  offerRewards,
  type Db,
} from "@promo/db";
import { validateRewardPayload } from "@promo/shared-types";
import { and, eq } from "drizzle-orm";
import type {
  AuthoringDeps,
  AuthoringResult,
  StoredCombinationPolicy,
  StoredCondition,
  StoredReward,
  ToStored,
} from "./types.js";

/**
 * Bundle authoring (reward kind `bundle_discount`), mirroring the bundle wizard action in
 * routes/app.offers.new.bundle.$template.tsx (classic bundle, mix & match, bundle page).
 *
 * What the wizard stores for one bundle offer, and who produces it here:
 *  - offer_rewards: one `bundle_discount` row               -> toStoredBundleRewards
 *  - offer_conditions: main `cart_quantity gte min(tier)`   -> bundleMainCondition
 *  - offer_combination_policies: bundle defaults            -> bundleCombinationPolicy
 *  - bundle_definitions + bundle_steps + bundle_tiers       -> bundleAfterInsert (inside the create transaction)
 *  - the reward target carries the offer's own id (tagged_offer), unknown until the offer row exists;
 *    toStored uses BUNDLE_OFFER_ID_PLACEHOLDER (the wizard validates with it too) and bundleAfterInsert swaps it.
 * Offer-level fields (name, title, labels, schedule, status, user subconditions) stay with the caller.
 *
 * Money: like the wizard, tier discount values and `amount` are stored as typed (major units), NOT x100.
 */

export const BUNDLE_OFFER_ID_PLACEHOLDER = "11111111-1111-4111-8111-111111111111";

const GID_RE = /^gid:\/\/shopify\/(?:Product|ProductVariant)\/[A-Za-z0-9_-]+$/;

const productRef = z.string().trim().min(1);

const BundleStepSchema = z.object({
  products: z.array(productRef).max(250).default([]).describe("Product or variant ids (numeric or GID) offered in this step."),
  minQuantity: z.number().int().min(1).default(1).describe("Minimum units the customer picks in this step."),
});

const BundleTierSchema = z.object({
  minQuantity: z.number().int().min(1).describe("Units in the bundle from which this tier applies."),
  maxQuantity: z.number().int().min(1).optional().describe("Upper bound of the tier (omit for open-ended)."),
  discountType: z.enum(["percentage", "fixed_amount", "fixed_price", "free"]).describe("How `value` is read."),
  value: z.number().min(0).describe("Percent (0-100) for percentage, otherwise money in major units (19.99)."),
  label: z.string().max(120).optional().describe("Tier label shown on the bundle widget."),
});

const LandingSchema = z.object({
  requiredLineAttributeValue: z
    .string()
    .trim()
    .min(1)
    .describe("Value of the `__landing_source` line attribute a line must carry for the discount to apply."),
  anchorVariantIds: z.array(z.string().min(1)).default([]).describe("Variant GIDs that must be in the cart (anchors)."),
  anchorMinQuantity: z.number().int().min(1).default(1).describe("Units of the anchor variants required."),
  requiresAnchorSubscription: z.boolean().default(false).describe("Anchor must be bought on subscription."),
  priceTiers: z
    .array(z.object({ quantity: z.number().int().min(1), targetPricePerUnit: z.number().min(0) }).strict())
    .min(1)
    .optional()
    .describe("Per-unit target prices by quantity, major units: [{quantity: 2, targetPricePerUnit: 24.5}]."),
  requiredLineAttribute: z
    .object({ key: z.string().min(1), value: z.string().min(1) })
    .optional()
    .describe("Extra required line attribute (key/value) besides __landing_source."),
});

export const AuthoringBundleRewardSchema = z.object({
  kind: z.literal("bundle_discount"),
  bundleType: z.enum(["classic", "mix_match", "bundle_page"]).describe("classic: pick any of `products`; mix_match: one step per `steps` item; bundle_page: stepped page (layoutMode)."),
  title: z.string().trim().min(1).optional().describe("Bundle definition title and default tier label. Pass the offer public title."),
  description: z.string().nullish().describe("Bundle definition description."),
  productLevel: z.enum(["product", "variant"]).default("product").describe("Track the bundle by product or by variant; also how numeric ids are read."),
  layoutMode: z.enum(["all_steps_one_page", "one_step_per_page"]).default("all_steps_one_page").describe("Only used by bundle_page."),
  products: z.array(productRef).max(250).default([]).describe("classic: bundle products (numeric id or GID)."),
  steps: z.array(BundleStepSchema).max(20).default([]).describe("mix_match / bundle_page steps (max 20)."),
  discountType: z.enum(["percentage", "fixed_amount", "fixed_price"]).default("percentage").describe("Discount used when `tiers` is empty."),
  discountValue: z.number().min(0).default(0).describe("Discount value used when `tiers` is empty (percent, or money in major units)."),
  tiers: z.array(BundleTierSchema).max(50).default([]).describe("Quantity tiers (max 50). Empty = one tier from discountType/discountValue at max(step minQuantity)."),
  currencyCode: z.string().length(3).optional().describe("Defaults to the shop currency."),
  landing: LandingSchema.optional().describe("Landing-page mode (scopeMode landing) instead of the wizard's tagged_offer: requires the __landing_source attribute and optional anchors / priceTiers."),
  combinesWithOrderDiscounts: z.boolean().default(false),
  combinesWithShippingDiscounts: z.boolean().default(false),
  forPublish: z.boolean().default(false).describe("Apply the wizard's publish-time checks (products selected, positive discount)."),
});
export type AuthoringBundleReward = z.input<typeof AuthoringBundleRewardSchema>;
type ParsedBundle = z.output<typeof AuthoringBundleRewardSchema>;

type Tier = {
  minimumQuantity: number;
  maximumQuantity?: number;
  discountType: string;
  discountValue: number;
  label: string;
};

type Prepared = {
  input: ParsedBundle;
  currencyCode: string;
  tiers: Tier[];
  classicProducts: string[];
  steps: Array<{ productGids: string[]; minQuantity: number }>;
  targets: string[];
  value: Record<string, unknown>;
  target: Record<string, unknown>;
  title: string;
};

const fail = <T>(error: string, path?: string): AuthoringResult<T> => ({ ok: false, error, ...(path ? { path } : {}) });

function normalizeId(id: string, level: "product" | "variant"): string {
  if (/^\d+$/.test(id)) return `gid://shopify/${level === "variant" ? "ProductVariant" : "Product"}/${id}`;
  return id;
}

/** Pure validation + normalisation shared by every export; same order and messages as the wizard action. */
export function prepareBundle(raw: AuthoringBundleReward, deps: AuthoringDeps): AuthoringResult<Prepared> {
  const parsed = AuthoringBundleRewardSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue?.message ?? "Invalid bundle reward.", issue?.path.join("."));
  }
  const input = parsed.data;
  const currencyCode = input.currencyCode ?? deps.shopCurrency;
  const title = input.title ?? "Bundle";

  const classicProducts = input.products.map((id) => normalizeId(id, input.productLevel));
  if (input.bundleType === "classic" && input.forPublish && classicProducts.length === 0) {
    return fail("Select at least one bundle product before publishing.", "products");
  }

  if (input.tiers.some((t) => t.maxQuantity !== undefined && t.maxQuantity < t.minQuantity)) {
    return fail("Every maximum bundle quantity must be greater than or equal to its minimum.", "tiers");
  }
  if (input.tiers.some((t) => t.discountType === "percentage" && t.value > 100)) {
    return fail("Bundle tier discounts must be valid non-negative values and percentages cannot exceed 100%.", "tiers");
  }
  const parsedTiers: Tier[] = input.tiers.map((t) => ({
    minimumQuantity: t.minQuantity,
    ...(t.maxQuantity === undefined ? {} : { maximumQuantity: t.maxQuantity }),
    discountType: t.discountType,
    discountValue: t.value,
    label: t.label ?? "",
  }));

  const steps = input.steps.map((s) => ({
    productGids: s.products.map((id) => normalizeId(id, input.productLevel)),
    minQuantity: s.minQuantity,
  }));
  const targets = Array.from(new Set([...classicProducts, ...steps.flatMap((s) => s.productGids)]));
  if (targets.some((id) => !GID_RE.test(id))) {
    return fail("Every bundle target must be a valid Shopify product or variant GID.", "products");
  }
  if (targets.length > 250) return fail("A bundle can target at most 250 products or variants.", "products");
  if (input.forPublish && targets.length === 0) return fail("Select at least one bundle product before publishing.", "products");

  const tiers: Tier[] =
    parsedTiers.length > 0
      ? parsedTiers
      : [
          {
            minimumQuantity: Math.max(1, ...steps.map((s) => s.minQuantity)),
            discountType: input.discountType,
            discountValue: input.discountValue,
            label: title,
          },
        ];
  if (
    input.forPublish &&
    !input.landing?.priceTiers &&
    tiers.every((t) => t.discountType !== "fixed_price" && t.discountValue <= 0)
  ) {
    return fail("Configure a positive bundle discount before publishing.", "discountValue");
  }

  const productIds = targets.filter((id) => id.includes("/Product/"));
  const variantIds = targets.filter((id) => id.includes("/ProductVariant/"));
  const value = { amount: 0, currencyCode, tiers };
  const target: Record<string, unknown> = input.landing
    ? {
        scopeMode: "landing",
        scope: "cart",
        productIds,
        variantIds,
        requiredLineAttributeKey: "__landing_source",
        requiredLineAttributeValue: input.landing.requiredLineAttributeValue,
        requiredAnchorVariantIds: input.landing.anchorVariantIds,
        requiredAnchorMinQuantity: input.landing.anchorMinQuantity,
        requiresAnchorSubscription: input.landing.requiresAnchorSubscription,
        ...(input.landing.priceTiers ? { priceTiers: input.landing.priceTiers } : {}),
        ...(input.landing.requiredLineAttribute ? { requiredLineAttribute: input.landing.requiredLineAttribute } : {}),
      }
    : {
        scopeMode: "tagged_offer",
        requiredOfferId: BUNDLE_OFFER_ID_PLACEHOLDER,
        scope: "cart",
        productIds,
        variantIds,
      };
  const validation = validateRewardPayload("bundle_discount", "percentage", value, target);
  if (!validation.success) {
    return fail(validation.error.issues[0]?.message ?? "Invalid bundle discount configuration.", "tiers");
  }
  return { ok: true, value: { input, currencyCode, tiers, classicProducts, steps, targets, value, target, title } };
}

function single(inputs: AuthoringBundleReward[], deps: AuthoringDeps): AuthoringResult<Prepared> {
  if (inputs.length !== 1) return fail("A bundle offer has exactly one bundle_discount reward.", "rewards");
  return prepareBundle(inputs[0]!, deps);
}

export const toStoredBundleRewards: ToStored<AuthoringBundleReward[], StoredReward[]> = async (inputs, deps) => {
  const prepared = single(inputs, deps);
  if (!prepared.ok) return prepared;
  const { input, value, target } = prepared.value;
  return {
    ok: true,
    value: [
      {
        rewardType: "bundle_discount",
        discountType: "percentage",
        value,
        target,
        isAutoAdd: false,
        isCustomerSelectable: false,
        trackMode: input.productLevel === "variant" ? "variant" : "product",
        sortOrder: 0,
      },
    ],
  };
};

/** Wizard main condition: cart_quantity gte the smallest tier quantity. */
export function bundleMainCondition(inputs: AuthoringBundleReward[], deps: AuthoringDeps): AuthoringResult<StoredCondition> {
  const prepared = single(inputs, deps);
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: {
      scope: "main",
      conditionType: "cart_quantity",
      operator: "gte",
      value: { minQuantity: Math.min(...prepared.value.tiers.map((t) => t.minimumQuantity)), includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    },
  };
}

/** Wizard policy: order/shipping discounts opt-in, product discounts and other apps combine, no stop-lower-priority. */
export function bundleCombinationPolicy(input: Pick<ParsedBundle, "combinesWithOrderDiscounts" | "combinesWithShippingDiscounts">): StoredCombinationPolicy {
  return {
    combinesWithOrderDiscounts: input.combinesWithOrderDiscounts ?? false,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: input.combinesWithShippingDiscounts ?? false,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Writes bundle_definitions, bundle_steps and bundle_tiers for the new offer and points the tagged reward at it,
 * in the caller's create transaction (createOfferGraph afterInsert hook).
 */
export function bundleAfterInsert(
  inputs: AuthoringBundleReward[],
  deps: AuthoringDeps,
): (tx: Tx, offerId: string) => Promise<void> {
  return async (tx, offerId) => {
    const prepared = single(inputs, deps);
    if (!prepared.ok) throw new Error(prepared.error);
    const { input, currencyCode, tiers, classicProducts, steps, title } = prepared.value;
    const { shopId } = deps;

    if (input.landing === undefined) {
      const rewards = await tx
        .select({ id: offerRewards.id, target: offerRewards.target })
        .from(offerRewards)
        .where(and(eq(offerRewards.offerId, offerId), eq(offerRewards.rewardType, "bundle_discount")));
      for (const reward of rewards) {
        await tx
          .update(offerRewards)
          .set({ target: { ...(reward.target as Record<string, unknown>), requiredOfferId: offerId } })
          .where(eq(offerRewards.id, reward.id));
      }
    }

    const [bundleDef] = await tx
      .insert(bundleDefinitions)
      .values({
        shopId,
        offerId,
        bundleType: input.bundleType,
        title,
        description: input.description ?? null,
        layoutMode: input.bundleType === "bundle_page" ? input.layoutMode : "all_steps_one_page",
        createBundleProduct: false,
        config: { productLevel: input.productLevel },
      })
      .returning({ id: bundleDefinitions.id });
    if (!bundleDef) throw new Error("Failed to create bundle definition");

    const stepRow = (stepTitle: string, productGids: string[], minQuantity: number, searchEnabled: boolean, sortOrder: number) => ({
      shopId,
      bundleId: bundleDef.id,
      title: stepTitle,
      sourceType: "products",
      sourceConfig: { productGids },
      minQuantity,
      maxQuantity: null,
      searchEnabled,
      sortOptions: [],
      filterOptions: [],
      sortOrder,
    });

    if (input.bundleType === "classic") {
      await tx.insert(bundleSteps).values(stepRow("Step 1 — Select products", classicProducts, 1, false, 0));
    } else if (input.bundleType === "mix_match") {
      for (let i = 0; i < steps.length; i++) {
        await tx.insert(bundleSteps).values(stepRow(`Mix item ${i + 1}`, steps[i]!.productGids, steps[i]!.minQuantity, false, i));
      }
      if (steps.length === 0) await tx.insert(bundleSteps).values(stepRow("Mix item 1", [], 1, false, 0));
    } else {
      const pageSteps = steps.length > 0 ? steps : [{ productGids: [], minQuantity: 1 }];
      for (let i = 0; i < pageSteps.length; i++) {
        await tx.insert(bundleSteps).values(stepRow(`Step ${i + 1}`, pageSteps[i]!.productGids, pageSteps[i]!.minQuantity, true, i));
      }
    }

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i]!;
      await tx.insert(bundleTiers).values({
        shopId,
        bundleId: bundleDef.id,
        minQuantity: tier.minimumQuantity,
        maxQuantity: tier.maximumQuantity ?? null,
        label: tier.label,
        discountType: tier.discountType as "percentage" | "fixed_amount" | "fixed_price" | "free",
        value: { amount: tier.discountValue, currencyCode },
        sortOrder: i,
      });
    }
  };
}
