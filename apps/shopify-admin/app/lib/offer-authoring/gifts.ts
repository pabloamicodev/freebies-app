import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { variantCache } from "@promo/db";
import { validateConditionValue, validateRewardPayload } from "@promo/shared-types";
import { mergeFallbacks, planGiftRewards } from "../gift-rewards.js";
import { loadProductOf } from "../gift-rewards.server.js";
import { buildTieredGiftOffer, giftTieredOfferSchema, type GiftTierCampaign } from "../gift-tier-campaigns.js";
import { toStoredAmount } from "../money.js";
import { matchRuleOperator, presenceOnlyValue } from "../product-condition.js";
import type { AuthoringDeps, AuthoringResult, StoredCondition, StoredReward, ToStored } from "./types.js";

/**
 * Gift authoring (MCP full access, package 06). Produces exactly the rows the gift wizard
 * (routes/app.offers.new.gift.$template.tsx action and lib/gift-tiered-offer.server.ts) stores.
 * Gifts are always stored as variant GIDs; a product id expands to its cached variants like the wizard picker does.
 * Limit semantics: a gift reward's quantity is how many gifts the customer picks / receives per grant of the SET, per gift
 * product; re-qualifying never duplicates it (enforced by the Function, not stored here).
 */

const idString = z.string().trim().min(1).max(120);

const variantGid = (raw: string): string | null => {
  const id = raw.trim();
  if (/^\d+$/.test(id)) return `gid://shopify/ProductVariant/${id}`;
  return /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id) ? id : null;
};
const productGid = (raw: string): string | null => {
  const id = raw.trim();
  if (/^\d+$/.test(id)) return `gid://shopify/Product/${id}`;
  return /^gid:\/\/shopify\/Product\/\d+$/.test(id) ? id : null;
};

export const AuthoringGiftSourceSchema = z
  .strictObject({
    productId: idString.optional().describe("Gift product (numeric id or GID). Alone: every variant of the product is a gift. With variantIds: only those variants."),
    variantIds: z.array(idString).min(1).max(100).optional().describe("Gift variants (numeric ids or GIDs)."),
    fallbackVariantIds: z
      .array(idString)
      .max(5)
      .optional()
      .describe("'If sold out, give instead': ordered replacement variants (max 5) for this gift, used only while it is sold out."),
  })
  .refine((g) => g.productId !== undefined || g.variantIds !== undefined, { message: "A gift needs productId and/or variantIds." });

const TierSchema = z.strictObject({
  minCartSubtotal: z.number().positive().describe("Cart subtotal that unlocks this tier, in MAJOR units of the shop currency (50 = 50.00). The subtotal never counts the gifts."),
  gifts: z.array(AuthoringGiftSourceSchema).min(1).max(20).describe("Gifts of this tier. One variant is auto-added; several variants make the tier a customer picker."),
  quantity: z.number().int().min(1).max(20).optional().describe("How many gifts the tier grants / the customer picks. Default 1."),
});

export const AuthoringGiftRewardSchema = z
  .strictObject({
    kind: z.literal("product_gift"),
    gifts: z
      .array(AuthoringGiftSourceSchema)
      .max(50)
      .optional()
      .describe("Gifts of a normal (non-tiered) gift offer. Required unless `tiers` is used."),
    customerSelectable: z
      .boolean()
      .optional()
      .describe("true = 'customer selects' (picker over every gift variant, one reward). Default false = 'automatically add all gifts': one reward per gift PRODUCT; a product with several picked variants opens the picker for that product only. One gift variant is always auto-added."),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Picker limit / gift count: how many gifts the customer picks (picker) or receives (one auto-added variant). Default 1. Ignored for add-all with several gifts (always 1 per product)."),
    fallbackVariantIds: z
      .array(idString)
      .max(5)
      .optional()
      .describe("Shared 'If sold out, give instead' list (max 5), used by the picker and by add-all gifts that have no list of their own."),
    discountType: z.enum(["free", "percentage", "fixed_amount"]).optional().describe("Default free (100% off)."),
    value: z.number().min(0).optional().describe("percentage: 0-100; fixed_amount: MAJOR units off per gift. Ignored for free."),
    minCartSubtotal: z.number().positive().optional().describe("Gate this single gift behind a cart subtotal (MAJOR units), stored as minCartSubtotalCents."),
    tiers: z
      .array(TierSchema)
      .min(1)
      .max(20)
      .optional()
      .describe("Gift tiers (one reward per tier, free gifts only, set offer.tierMode cumulative|highest through promo_set_tier_mode). Thresholds must be unique. Mutually exclusive with gifts / minCartSubtotal."),
  })
  .superRefine((g, ctx) => {
    if (g.tiers) {
      if (g.gifts?.length || g.minCartSubtotal !== undefined) ctx.addIssue({ code: "custom", path: ["tiers"], message: "Use either tiers or gifts (with optional minCartSubtotal), not both." });
      if (g.discountType && g.discountType !== "free") ctx.addIssue({ code: "custom", path: ["discountType"], message: "Gift tiers are always free." });
      const seen = new Set<number>();
      g.tiers.forEach((t, i) => {
        if (seen.has(t.minCartSubtotal)) ctx.addIssue({ code: "custom", path: ["tiers", i, "minCartSubtotal"], message: "Tier thresholds must be unique." });
        seen.add(t.minCartSubtotal);
      });
    } else if (!g.gifts?.length) {
      ctx.addIssue({ code: "custom", path: ["gifts"], message: "Add at least one gift product or variant (or use tiers)." });
    }
    if (g.discountType === "percentage" && g.value !== undefined && g.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage cannot exceed 100." });
  });
export type AuthoringGiftReward = z.infer<typeof AuthoringGiftRewardSchema>;

type Fail = { ok: false; error: string; path?: string };
const fail = (error: string, path?: string): Fail => ({ ok: false, error, ...(path ? { path } : {}) });

type Resolved = { variantIds: string[]; fallbackByVariant: Record<string, string[]> };

async function resolveGiftSources(deps: AuthoringDeps, sources: z.infer<typeof AuthoringGiftSourceSchema>[], path: string): Promise<AuthoringResult<Resolved>> {
  const variantIds: string[] = [];
  const fallbackByVariant: Record<string, string[]> = {};
  for (const [index, source] of sources.entries()) {
    const at = `${path}[${index}]`;
    let own: string[] = [];
    if (source.variantIds) {
      for (const raw of source.variantIds) {
        const gid = variantGid(raw);
        if (!gid) return fail(`"${raw}" is not a variant id or ProductVariant GID.`, `${at}.variantIds`);
        own.push(gid);
      }
    } else if (source.productId) {
      const product = productGid(source.productId);
      if (!product) return fail(`"${source.productId}" is not a product id or Product GID.`, `${at}.productId`);
      const rows = await deps.db
        .select({ gid: variantCache.variantGid })
        .from(variantCache)
        .where(and(eq(variantCache.shopId, deps.shopId), eq(variantCache.productGid, product)));
      if (rows.length === 0) return fail(`Product ${product} has no cached variants in this shop; sync the catalog or pass variantIds.`, `${at}.productId`);
      own = rows.map((r) => r.gid).sort();
    }
    if (source.variantIds && source.productId) {
      const product = productGid(source.productId);
      if (!product) return fail(`"${source.productId}" is not a product id or Product GID.`, `${at}.productId`);
      const owners = await loadProductOf(deps.db, deps.shopId, own);
      const stray = own.find((id) => owners.get(id) !== undefined && owners.get(id) !== product);
      if (stray) return fail(`Variant ${stray} does not belong to ${product}.`, `${at}.variantIds`);
    }
    const fallbacks: string[] = [];
    for (const raw of source.fallbackVariantIds ?? []) {
      const gid = variantGid(raw);
      if (!gid) return fail(`"${raw}" is not a variant id or ProductVariant GID.`, `${at}.fallbackVariantIds`);
      fallbacks.push(gid);
    }
    for (const id of own) {
      if (!variantIds.includes(id)) variantIds.push(id);
      if (fallbacks.length > 0) fallbackByVariant[id] = fallbacks;
    }
  }
  return { ok: true, value: { variantIds, fallbackByVariant } };
}

function sharedFallbacks(raw: string[] | undefined, path: string): AuthoringResult<string[]> {
  const out: string[] = [];
  for (const id of raw ?? []) {
    const gid = variantGid(id);
    if (!gid) return fail(`"${id}" is not a variant id or ProductVariant GID.`, path);
    out.push(gid);
  }
  return { ok: true, value: out };
}

function rewardAmount(g: AuthoringGiftReward, currency: string): AuthoringResult<{ discountType: "free" | "percentage" | "fixed_amount"; value: Record<string, unknown> }> {
  const discountType = g.discountType ?? "free";
  if (discountType !== "free" && g.value === undefined) return fail(`value is required for ${discountType}.`, "value");
  const amount = discountType === "free" ? 100 : discountType === "percentage" ? g.value! : toStoredAmount(g.value!, currency);
  return { ok: true, value: { discountType, value: { amount, currencyCode: currency } } };
}

async function toStoredOne(g: AuthoringGiftReward, deps: AuthoringDeps, index: number): Promise<AuthoringResult<StoredReward[]>> {
  const base = `rewards[${index}]`;
  if (g.tiers) {
    const campaign: GiftTierCampaign = { campaignId: "mcp", name: "mcp", stackingMode: "cumulative", tiers: [] };
    for (const [t, tier] of g.tiers.entries()) {
      const resolved = await resolveGiftSources(deps, tier.gifts, `${base}.tiers[${t}].gifts`);
      if (!resolved.ok) return resolved;
      const own = new Set(resolved.value.variantIds);
      const fallbacks = [...new Set(Object.values(resolved.value.fallbackByVariant).flat())].filter((id) => !own.has(id)).slice(0, 5);
      campaign.tiers.push({
        id: `t${t + 1}`,
        minimumSubtotalCents: toStoredAmount(tier.minCartSubtotal, deps.shopCurrency),
        variantIds: resolved.value.variantIds,
        ...(fallbacks.length ? { fallbackVariantIds: fallbacks } : {}),
        quantity: tier.quantity ?? 1,
      });
    }
    const parsed = giftTieredOfferSchema.safeParse(campaign);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Gift tiers are invalid.", `${base}.tiers`);
    const rewards = buildTieredGiftOffer(parsed.data, deps.shopCurrency).rewards.map((r): StoredReward => ({ ...r }));
    return validated(rewards, base);
  }

  const amount = rewardAmount(g, deps.shopCurrency);
  if (!amount.ok) return { ...amount, path: `${base}.${amount.path ?? "value"}` };
  const { discountType, value } = amount.value;
  const resolved = await resolveGiftSources(deps, g.gifts ?? [], `${base}.gifts`);
  if (!resolved.ok) return resolved;
  const { variantIds, fallbackByVariant } = resolved.value;
  const shared = sharedFallbacks(g.fallbackVariantIds, `${base}.fallbackVariantIds`);
  if (!shared.ok) return shared;

  const hasPerGift = Object.keys(fallbackByVariant).length > 0;
  // A fallback that is also a primary gift would never act as a replacement.
  const sharedList = shared.value.filter((id) => !variantIds.includes(id));
  // One variant (incl. a product with no options) leaves nothing to pick.
  const autoAdd = !g.customerSelectable || variantIds.length === 1;
  const quantity = g.quantity ?? 1;
  const minCents = g.minCartSubtotal !== undefined ? toStoredAmount(g.minCartSubtotal, deps.shopCurrency) : undefined;

  let rows: StoredReward[];
  if (autoAdd && variantIds.length >= 2) {
    const byVariant: Record<string, string[]> = {};
    for (const id of variantIds) byVariant[id] = fallbackByVariant[id] ?? sharedList;
    const plan = planGiftRewards({
      existing: [],
      variantIds,
      productOf: await loadProductOf(deps.db, deps.shopId, variantIds),
      fallbackVariantIds: hasPerGift ? mergeFallbacks(byVariant, variantIds) : sharedList,
      ...(hasPerGift ? { fallbackByVariant: byVariant } : {}),
      autoAddAll: true,
      quantity: 1,
      discountType: discountType as never,
      value,
    });
    rows = plan.insert.map((r) => ({ rewardType: "product_gift" as const, ...r }));
  } else {
    const fallback = hasPerGift ? mergeFallbacks(fallbackByVariant, variantIds) : sharedList;
    const merged = [...new Set([...fallback, ...sharedList])].filter((id) => !variantIds.includes(id)).slice(0, 5);
    rows = [
      {
        rewardType: "product_gift",
        discountType,
        value,
        target: { scope: "cart", variantIds, ...(merged.length > 0 ? { fallbackVariantIds: merged } : {}) },
        quantity,
        isAutoAdd: autoAdd,
        isCustomerSelectable: !autoAdd,
        trackMode: "product",
        sortOrder: 0,
      },
    ];
  }
  if (minCents !== undefined) rows = rows.map((r) => ({ ...r, minCartSubtotalCents: minCents }));
  return validated(rows, base);
}

function validated(rows: StoredReward[], path: string): AuthoringResult<StoredReward[]> {
  for (const [i, row] of rows.entries()) {
    const check = validateRewardPayload(row.rewardType, row.discountType, row.value, row.target);
    if (!check.success) return fail(check.error.issues[0]?.message ?? "Invalid gift reward.", `${path}[${i}]`);
  }
  return { ok: true, value: rows };
}

/** Gift rewards in the exact shape the gift wizard writes to offer_rewards (incl. one reward per product for add-all). */
export const toStoredGiftRewards: ToStored<AuthoringGiftReward[], StoredReward[]> = async (input, deps) => {
  const out: StoredReward[] = [];
  for (const [index, gift] of input.entries()) {
    const result = await toStoredOne(gift, deps, index);
    if (!result.ok) return result;
    out.push(...result.value);
  }
  return { ok: true, value: out.map((r, sortOrder) => ({ ...r, sortOrder })) };
};

const appliesTo = z.string().trim().min(1).max(40).optional().describe("Which products count: any_product (default) or the wizard's other values.");

/** What a gift offer is triggered by (the wizard's main condition). Omit it for tiered / minCartSubtotal gifts: the lowest tier is used. */
export const AuthoringGiftTriggerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cart_value"),
    minAmount: z.number().min(0).describe("Minimum cart subtotal, MAJOR units."),
    maxAmount: z.number().min(0).optional().describe("Optional ceiling, MAJOR units (0/omitted = none)."),
    appliesTo,
  }),
  z.strictObject({ type: z.literal("cart_quantity"), minQuantity: z.number().int().min(1), appliesTo }),
  z.strictObject({
    type: z.literal("specific_product"),
    variantIds: z.array(idString).min(1).max(100).describe("Qualifying variants (numeric ids or GIDs)."),
    minQtyPerProduct: z.number().int().min(1).optional(),
    multiplyGifts: z.boolean().optional().describe("Give the gift set once per qualifying multiple."),
    giftsMatchProducts: z.boolean().optional(),
    trackMode: z.enum(["product", "variant"]).optional().describe("Default product."),
    matchRule: z.enum(["all", "any"]).optional().describe("all (default): every listed product must be in the cart; any: one is enough."),
  }),
]);
export type AuthoringGiftTrigger = z.infer<typeof AuthoringGiftTriggerSchema>;

/**
 * The main (scope "main") condition the gift wizard derives:
 * - explicit trigger: cart_value (thresholdCents, maxAmountCents, appliesTo, includeGiftValues:false), cart_quantity
 *   (minQuantity) or specific_product (min qty, multiply, match rule operator);
 * - no trigger: tiered / minCartSubtotal gifts qualify at their LOWEST tier (cart_value gte lowest tier, like
 *   createTieredGiftOffer); anything else is an error.
 * Package 03 must call this when the offer is type gift and the caller gave no main condition.
 */
export function giftMainCondition(
  gifts: AuthoringGiftReward[],
  trigger: AuthoringGiftTrigger | undefined,
  deps: Pick<AuthoringDeps, "shopCurrency">,
): AuthoringResult<StoredCondition> {
  let condition: StoredCondition;
  if (!trigger) {
    const thresholds = gifts.flatMap((g) => [...(g.tiers?.map((t) => t.minCartSubtotal) ?? []), ...(g.minCartSubtotal !== undefined ? [g.minCartSubtotal] : [])]);
    if (thresholds.length === 0) return fail("A gift offer needs a trigger (cart_value, cart_quantity or specific_product) unless its gifts have minCartSubtotal or tiers.", "trigger");
    condition = {
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents: toStoredAmount(Math.min(...thresholds), deps.shopCurrency), currencyCode: deps.shopCurrency, includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    };
  } else if (trigger.type === "cart_value") {
    condition = {
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: {
        thresholdCents: toStoredAmount(trigger.minAmount, deps.shopCurrency),
        maxAmountCents: toStoredAmount(trigger.maxAmount ?? 0, deps.shopCurrency),
        appliesTo: trigger.appliesTo ?? "any_product",
        includeGiftValues: false,
      },
      sortOrder: 0,
      isEnabled: true,
    };
  } else if (trigger.type === "cart_quantity") {
    condition = {
      scope: "main",
      conditionType: "cart_quantity",
      operator: "gte",
      value: { minQuantity: trigger.minQuantity, appliesTo: trigger.appliesTo ?? "any_product", includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    };
  } else {
    const ids: string[] = [];
    for (const raw of trigger.variantIds) {
      const gid = variantGid(raw);
      if (!gid) return fail(`"${raw}" is not a variant id or ProductVariant GID.`, "trigger.variantIds");
      ids.push(gid);
    }
    const operator = matchRuleOperator(trigger.matchRule ?? "all");
    const value = {
      minQtyPerProduct: trigger.minQtyPerProduct ?? 1,
      multiplyGifts: trigger.multiplyGifts ?? false,
      giftsMatchProducts: trigger.giftsMatchProducts ?? false,
      trackMode: trigger.trackMode ?? "product",
      appliesTo: "specific_products",
      variantIds: ids,
    };
    condition = {
      scope: "main",
      conditionType: "specific_product",
      operator,
      value: operator === "any" ? presenceOnlyValue(value) : value,
      sortOrder: 0,
      isEnabled: true,
    };
  }
  // The wizard's specific_product value (minQtyPerProduct/variantIds) predates the shared-types requirements shape and is
  // stored as-is (product-condition.ts reads it); only the shapes shared-types knows are validated.
  const check = condition.conditionType === "specific_product" ? { success: true as const } : validateConditionValue(condition.conditionType, condition.value);
  if (!check.success) return fail(check.error.issues[0]?.message ?? "Invalid gift trigger.", "trigger");
  return { ok: true, value: condition };
}
