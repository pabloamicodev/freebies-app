import { z } from "zod";
import { productCache, variantCache } from "@promo/db";
import { validateConditionValue, validateRewardPayload } from "@promo/shared-types";
import { and, eq, inArray } from "drizzle-orm";
import { toStoredAmount } from "../money.js";
import { parseQuantityTiers } from "../quantity-tiers.js";
import { withSubscriptionMode } from "../purchase-type.js";
import { resolveSelection } from "../whole-product-selection.server.js";
import type { AuthoringDeps, AuthoringResult, StoredCondition, StoredReward, ToStored } from "./types.js";

/**
 * Authoring input for the discount families (product_discount, order_discount). `toStoredDiscountRewards`
 * produces exactly what the discount wizard (routes/app.offers.new.discount.$template.tsx) writes.
 * Money is in MAJOR units of the shop currency; ids accept numeric ids or GIDs.
 */

const idInput = z.union([z.string().trim().min(1).max(200), z.number().int().positive()]);
const subscriptionMode = z
  .enum(["any", "subscription_only", "one_time_only"])
  .default("any")
  .describe("Purchase type the discount applies to. Default any (one-time and subscriptions).");

const productTier = z.strictObject({
  minQuantity: z.number().int().min(1).describe("Units of the targeted products from which this tier applies."),
  maxQuantity: z.number().int().min(1).optional().describe("Highest unit count of this tier; omit for 'and more'."),
  discountType: z.enum(["percentage", "fixed_amount", "fixed_price", "free"]).describe("percentage: value is 0-100. fixed_amount: value is the amount off per unit, in shop-currency major units. fixed_price: value is the unit price. free: no value."),
  value: z.number().min(0).optional().describe("Discount value (see discountType). Required unless discountType is free."),
  discountedQuantity: z.number().int().min(1).optional().describe("Units discounted at this tier (e.g. 1 = only the cheapest/priciest one). Omit to discount every unit; defaults to 1 for selection cheapest / most_expensive."),
  label: z.string().trim().max(120).optional().describe("Tier title shown in the widget."),
  cartLabels: z.array(z.string().trim().min(1).max(40)).max(3).optional().describe("Up to 3 short labels appended to the discount name in cart and checkout."),
});

const orderTier = z.strictObject({
  minimum: z.number().min(0).describe("Lower bound: cart subtotal in shop-currency major units (by subtotal) or total units (by quantity)."),
  maximum: z.number().min(0).optional().describe("Upper bound, same unit; omit for 'and more'."),
  discountType: z.enum(["percentage", "fixed_amount", "free"]).optional().describe("Overrides the reward's discountType for this tier."),
  value: z.number().min(0).optional().describe("percentage 0-100, or fixed amount off the order in shop-currency major units. Required unless free."),
  label: z.string().trim().max(120).optional().describe("Tier title shown in the widget."),
});

export const AuthoringProductDiscountSchema = z.strictObject({
  kind: z.literal("product_discount").describe("Discounts units of products (volume tiers, flat discount, cheapest/most expensive item)."),
  target: z
    .strictObject({
      scope: z.enum(["selected", "all_products"]).describe("selected: only the listed products/variants. all_products: every product in the cart."),
      products: z.array(idInput).max(500).optional().describe("Whole products, by numeric id or GID (e.g. 9208279269615)."),
      variants: z.array(idInput).max(500).optional().describe("Individual variants, by numeric id or GID."),
      wholeProducts: z.array(idInput).max(500).optional().describe("Products whose variants are ALL listed in `variants`; they are then stored as whole products."),
    })
    .describe("Which products the discount applies to."),
  quantityTiers: z.array(productTier).min(1).max(20).optional().describe("Quantity-based tiers, ascending and non-overlapping, e.g. [{minQuantity:1,maxQuantity:1,discountType:'percentage',value:20},{minQuantity:2,discountType:'percentage',value:30}]. Use this or `discount`."),
  discount: z
    .strictObject({
      discountType: z.enum(["percentage", "fixed_amount", "free"]),
      value: z.number().min(0).optional().describe("percentage 0-100, or amount off per unit in major units. Omit for free."),
    })
    .optional()
    .describe("A flat discount without quantity tiers. Use this or `quantityTiers`."),
  selection: z.enum(["all", "cheapest", "most_expensive"]).default("all").describe("all: every eligible unit. cheapest / most_expensive: only that item of the eligible set (use with discountedQuantity)."),
  countRule: z.enum(["all", "unique"]).default("all").describe("all: every unit counts toward the tier. unique: each distinct product counts once."),
  displayType: z.enum(["quantity_options", "discount_table"]).default("quantity_options").describe("How the storefront widget shows the tiers."),
  subscriptionMode,
});

export const AuthoringOrderDiscountSchema = z.strictObject({
  kind: z.literal("order_discount").describe("Discounts the whole order by cart subtotal or total quantity tiers."),
  by: z.enum(["subtotal", "quantity"]).default("subtotal").describe("subtotal: tiers bounded by cart value. quantity: tiers bounded by total units."),
  discountType: z.enum(["percentage", "fixed_amount", "free"]).default("percentage").describe("Default discount type of every tier."),
  tiers: z.array(orderTier).min(1).max(20).describe("Ascending, non-overlapping tiers."),
  subscriptionMode,
});

export const AuthoringDiscountRewardSchema = z.discriminatedUnion("kind", [AuthoringProductDiscountSchema, AuthoringOrderDiscountSchema]);
export type AuthoringDiscountReward = z.input<typeof AuthoringDiscountRewardSchema>;
type ParsedDiscountReward = z.output<typeof AuthoringDiscountRewardSchema>;

const fail = (error: string, path?: string): { ok: false; error: string; path?: string } => ({ ok: false, error, ...(path ? { path } : {}) });

const GID = { product: /^gid:\/\/shopify\/Product\/\d+$/, variant: /^gid:\/\/shopify\/ProductVariant\/\d+$/ };

function toGid(kind: "Product" | "ProductVariant", raw: string | number): string | null {
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return `gid://shopify/${kind}/${value}`;
  return (kind === "Product" ? GID.product : GID.variant).test(value) ? value : null;
}

function gids(kind: "Product" | "ProductVariant", raw: ReadonlyArray<string | number> | undefined, field: string): AuthoringResult<string[]> {
  const out: string[] = [];
  for (const item of raw ?? []) {
    const gid = toGid(kind, item);
    if (!gid) return fail(`${field}: "${item}" is not a numeric id or a ${kind} GID. Resolve names and handles with catalog_search.`, field);
    out.push(gid);
  }
  return { ok: true, value: [...new Set(out)] };
}

/** Every referenced product/variant must be in the shop's catalog cache, so a typo never becomes a dead offer. */
async function ensureInCatalog(deps: AuthoringDeps, products: string[], variants: string[]): Promise<string | null> {
  if (products.length > 0) {
    const rows = await deps.db
      .select({ gid: productCache.productGid })
      .from(productCache)
      .where(and(eq(productCache.shopId, deps.shopId), inArray(productCache.productGid, products)));
    const known = new Set(rows.map((row) => row.gid));
    const missing = products.filter((gid) => !known.has(gid));
    if (missing.length > 0) return `Product not found in ${deps.shopDomain}'s catalog: ${missing.join(", ")}. Check the id with catalog_search or sync the catalog first.`;
  }
  if (variants.length > 0) {
    const rows = await deps.db
      .select({ gid: variantCache.variantGid })
      .from(variantCache)
      .where(and(eq(variantCache.shopId, deps.shopId), inArray(variantCache.variantGid, variants)));
    const known = new Set(rows.map((row) => row.gid));
    const missing = variants.filter((gid) => !known.has(gid));
    if (missing.length > 0) return `Variant not found in ${deps.shopDomain}'s catalog: ${missing.join(", ")}. Check the id with catalog_search or sync the catalog first.`;
  }
  return null;
}

function tierValue(type: string, value: number | undefined, where: string): AuthoringResult<number> {
  if (type === "free") return { ok: true, value: 100 };
  if (value === undefined) return fail(`${where}: a value is required unless the discount type is free.`, where);
  return { ok: true, value };
}

async function productReward(input: Extract<ParsedDiscountReward, { kind: "product_discount" }>, deps: AuthoringDeps, index: number): Promise<AuthoringResult<StoredReward>> {
  const at = `rewards[${index}]`;
  if (!input.quantityTiers === !input.discount) return fail(`${at}: set exactly one of quantityTiers or discount.`, at);
  const products = gids("Product", input.target.products, `${at}.target.products`);
  if (!products.ok) return products;
  const variants = gids("ProductVariant", input.target.variants, `${at}.target.variants`);
  if (!variants.ok) return variants;
  const whole = gids("Product", input.target.wholeProducts, `${at}.target.wholeProducts`);
  if (!whole.ok) return whole;
  const selected = input.target.scope === "selected";
  if (selected && products.value.length === 0 && variants.value.length === 0) return fail("Select at least one product or variant for scope \"selected\".", `${at}.target`);
  if (!selected && (products.value.length > 0 || variants.value.length > 0)) return fail("scope \"all_products\" takes no products or variants; use scope \"selected\" to restrict the discount.", `${at}.target`);

  const missing = selected ? await ensureInCatalog(deps, products.value, variants.value) : null;
  if (missing) return fail(missing, `${at}.target`);
  const selection = selected ? await resolveSelection(deps.db, deps.shopId, [...products.value, ...variants.value], whole.value) : null;

  const cheapestLike = input.selection !== "all";
  let value: Record<string, unknown>;
  let discountType = "percentage";
  if (input.quantityTiers) {
    const raw = [];
    for (const [i, tier] of input.quantityTiers.entries()) {
      const amount = tierValue(tier.discountType, tier.value, `${at}.quantityTiers[${i}].value`);
      if (!amount.ok) return amount;
      raw.push({
        minimumQuantity: tier.minQuantity,
        ...(tier.maxQuantity === undefined ? {} : { maximumQuantity: tier.maxQuantity }),
        discountType: tier.discountType,
        discountValue: amount.value,
        ...(tier.discountedQuantity !== undefined ? { discountedQuantity: tier.discountedQuantity } : cheapestLike ? { discountedQuantity: 1 } : {}),
        ...(tier.label ? { label: tier.label } : {}),
        ...(tier.cartLabels ? { cartLabels: tier.cartLabels } : {}),
      });
    }
    const parsed = parseQuantityTiers(raw);
    if (!parsed.ok) return fail(`${at}.quantityTiers: ${parsed.error}`, `${at}.quantityTiers`);
    value = { amount: 0, currencyCode: "USD", tiers: parsed.tiers };
  } else {
    const flat = input.discount!;
    const amount = tierValue(flat.discountType, flat.value, `${at}.discount.value`);
    if (!amount.ok) return amount;
    if (flat.discountType === "percentage" && amount.value > 100) return fail("Percentage discounts cannot exceed 100%.", `${at}.discount.value`);
    discountType = flat.discountType;
    value = { amount: flat.discountType === "fixed_amount" ? toStoredAmount(amount.value, deps.shopCurrency) : amount.value, currencyCode: deps.shopCurrency };
  }

  const target = {
    ...(input.subscriptionMode === "any" ? {} : { subscriptionMode: input.subscriptionMode }),
    scopeMode: "sitewide",
    scope: selected ? "cart" : "all_products",
    ...(selection
      ? { productIds: selection.productIds, variantIds: selection.variantIds, ...(selection.selectionLevel ? { selectionLevel: selection.selectionLevel } : {}) }
      : {}),
    selectionMode: input.selection,
    countRule: input.countRule,
    displayType: input.displayType,
  };
  return checked({ rewardType: "product_discount", discountType: discountType as StoredReward["discountType"], value, target, sortOrder: 0, trackMode: "product", isAutoAdd: false, isCustomerSelectable: false }, at);
}

function orderReward(input: Extract<ParsedDiscountReward, { kind: "order_discount" }>, deps: AuthoringDeps, index: number): AuthoringResult<StoredReward> {
  const at = `rewards[${index}]`;
  const bySubtotal = input.by === "subtotal";
  const tiers = [];
  let previous: { minimum: number; maximum?: number } | undefined;
  for (const [i, tier] of input.tiers.entries()) {
    const where = `${at}.tiers[${i}]`;
    const type = tier.discountType ?? input.discountType;
    const amount = tierValue(type, tier.value, `${where}.value`);
    if (!amount.ok) return amount;
    if (type === "percentage" && amount.value > 100) return fail("Percentage discounts cannot exceed 100%.", `${where}.value`);
    if (tier.maximum !== undefined && tier.maximum < tier.minimum) return fail("Every maximum tier bound must be greater than or equal to its minimum.", where);
    if (previous && (previous.maximum === undefined || tier.minimum <= previous.maximum)) return fail(`Tier ${i + 1} overlaps the tier before it: tiers must be ascending and non-overlapping.`, where);
    previous = tier;
    tiers.push({
      ...(bySubtotal
        ? {
            minimumSubtotalCents: toStoredAmount(tier.minimum, deps.shopCurrency),
            ...(tier.maximum === undefined ? {} : { maximumSubtotalCents: toStoredAmount(tier.maximum, deps.shopCurrency) }),
          }
        : {
            minimumQuantity: Math.max(1, Math.trunc(tier.minimum)),
            ...(tier.maximum === undefined ? {} : { maximumQuantity: Math.trunc(tier.maximum) }),
          }),
      discountType: type,
      discountValue: amount.value,
      label: tier.label ?? "",
    });
  }
  return checked(
    {
      rewardType: "order_discount",
      discountType: input.discountType,
      value: { amount: 0, currencyCode: "USD", tiers },
      target: withSubscriptionMode({ scope: "cart" }, input.subscriptionMode),
      sortOrder: 0,
      trackMode: "product",
      isAutoAdd: false,
      isCustomerSelectable: false,
    },
    at,
  );
}

function checked(reward: StoredReward, at: string): AuthoringResult<StoredReward> {
  const result = validateRewardPayload(reward.rewardType, reward.discountType, reward.value, reward.target);
  if (!result.success) return fail(`${at}: ${result.error.issues[0]?.message ?? "invalid reward"}`, at);
  return { ok: true, value: reward };
}

export const toStoredDiscountRewards: ToStored<AuthoringDiscountReward[], StoredReward[]> = async (inputs, deps) => {
  const out: StoredReward[] = [];
  for (const [index, raw] of inputs.entries()) {
    const parsed = AuthoringDiscountRewardSchema.safeParse(raw);
    if (!parsed.success) return fail(`rewards[${index}]: ${parsed.error.issues[0]?.message ?? "invalid reward"}`, `rewards[${index}]`);
    const result = parsed.data.kind === "product_discount" ? await productReward(parsed.data, deps, index) : orderReward(parsed.data, deps, index);
    if (!result.ok) return result;
    out.push({ ...result.value, sortOrder: index });
  }
  return { ok: true, value: out };
};

/**
 * The main condition the wizards derive from the first reward when the caller gives none:
 * product tiers -> cart_quantity gte (lowest tier minimum); a flat product discount -> cart_quantity gte 1;
 * order tiers by subtotal -> cart_value gte (lowest tier minimum); by quantity -> cart_quantity gte.
 */
export function mainConditionForRewards(inputs: AuthoringDiscountReward[], deps: Pick<AuthoringDeps, "shopCurrency">): AuthoringResult<StoredCondition> {
  const first = inputs[0] ? AuthoringDiscountRewardSchema.safeParse(inputs[0]) : null;
  if (!first?.success) return fail("A discount reward is required to derive the main condition.", "rewards");
  const reward = first.data;
  let type: "cart_value" | "cart_quantity" = "cart_quantity";
  let minimum = 1;
  if (reward.kind === "product_discount") {
    if (reward.quantityTiers) minimum = Math.min(...reward.quantityTiers.map((tier) => tier.minQuantity));
  } else {
    minimum = Math.min(...reward.tiers.map((tier) => tier.minimum));
    if (reward.by === "subtotal") type = "cart_value";
  }
  const value: Record<string, unknown> =
    type === "cart_value"
      ? { thresholdCents: toStoredAmount(Number.isFinite(minimum) ? minimum : 0, deps.shopCurrency), currencyCode: deps.shopCurrency, includeGiftValues: false }
      : { minQuantity: Math.max(1, Math.trunc(Number.isFinite(minimum) ? minimum : 1)), includeGiftValues: false };
  const valid = validateConditionValue(type, value);
  if (!valid.success) return fail(`Main condition is invalid: ${valid.error.issues[0]?.message ?? type}`, "rewards");
  return { ok: true, value: { scope: "main", conditionType: type, operator: "gte", value, sortOrder: 0, isEnabled: true } };
}
