import { z } from "zod";
import { validateRewardPayload } from "@promo/shared-types";
import { resolveSelection } from "../whole-product-selection.server.js";
import { toStoredAmount } from "../money.js";
import type {
  AuthoringDeps,
  AuthoringResult,
  StoredCombinationPolicy,
  StoredCondition,
  StoredReward,
  ToStored,
} from "./types.js";

/**
 * Upsell authoring (reward kind `upsell_discount`), mirroring the upsell wizard action in
 * routes/app.offers.new.upsell.$template.tsx (checkout upsell, frequently bought together, thank-you upsell).
 *
 * What the wizard stores for one upsell offer, and who produces it here:
 *  - offer_rewards: one `upsell_discount` row (sitewide target = the upsell products)  -> toStoredUpsellRewards
 *  - offer_conditions: main (specific_product trigger or cart_quantity gte 1), a `visibility` sales_channels row that
 *    carries the widget settings, the user's subconditions, and an exclude_products row for product_except
 *                                                                                      -> toStoredUpsellConditions
 *  - offer_combination_policies: upsell defaults                                       -> upsellCombinationPolicy
 *  - no extra tables: upsellAfterInsert is a no-op kept so composers treat every family the same way.
 * Offer-level fields (name, title, schedule, status) stay with the caller.
 *
 * Not expressible: the wizard stores collection triggers (collection_selected / collection_except) only as
 * visibility metadata, never as product conditions, so they behave like "always" here too.
 */

const ref = z.string().trim().min(1);

export const AuthoringUpsellRewardSchema = z.object({
  kind: z.literal("upsell_discount"),
  template: z.enum(["checkout", "fbt", "thank_you"]).default("checkout").describe("checkout: checkout/cart/post-purchase upsell; fbt: frequently bought together; thank_you: thank-you page upsell."),
  triggerType: z
    .enum(["always", "product", "product_selected", "product_except", "collection_selected", "collection_except", "cart", "customer"])
    .default("always")
    .describe("When the upsell shows. product / product_selected: only with the trigger products; product_except: with any product except them."),
  triggerProducts: z.array(ref).max(250).default([]).describe("Trigger product or variant ids (numeric or GID)."),
  triggerMatchRule: z.enum(["any", "all"]).default("any").describe("any: one trigger product is enough; all: every trigger product must be in the cart."),
  upsellMethod: z.enum(["manual", "auto", "random"]).default("manual").describe("How the upsell products are chosen (random is not available for checkout)."),
  widgetType: z.enum(["fbt", "product_add_on"]).default("fbt").describe("fbt template only."),
  checkoutTarget: z.enum(["checkout", "post_purchase", "cart"]).nullish().describe("checkout template only: surface where the upsell shows."),
  allowCustomerQty: z.boolean().default(false).describe("fbt only: customer can change the quantity."),
  discountEnabled: z.boolean().default(false).describe("fbt only: the bundle carries a discount (otherwise the reward amount is 0)."),
  discountMinProducts: z.number().int().min(1).default(2).describe("fbt only: products needed in the set."),
  discountApplyTo: z.enum(["any", "cheapest", "most_expensive"]).default("any").describe("fbt only: which item the discount applies to."),
  discountType: z.enum(["percentage", "fixed_amount", "fixed_price", "free"]).default("percentage"),
  discountValue: z.number().min(0).default(10).describe("Percent (0-100) for percentage, otherwise money in major units."),
  upsellProducts: z.array(ref).max(250).default([]).describe("Upsell product or variant ids (numeric or GID) offered to the customer."),
  upsellWholeProducts: z.array(ref).default([]).describe("Product ids ticked as a whole in the picker; their variants collapse back to the product id."),
  subscriptionMode: z.enum(["any", "subscription_only", "one_time_only"]).default("any"),
  combinesWithOrderDiscounts: z.boolean().default(true),
  combinesWithShippingDiscounts: z.boolean().default(true),
  forPublish: z.boolean().default(false).describe("Apply the wizard's publish-time checks (upsell/trigger products selected)."),
});
export type AuthoringUpsellReward = z.input<typeof AuthoringUpsellRewardSchema>;
type ParsedUpsell = z.output<typeof AuthoringUpsellRewardSchema>;

const fail = <T>(error: string, path?: string): AuthoringResult<T> => ({ ok: false, error, ...(path ? { path } : {}) });

const toGid = (id: string) => (/^\d+$/.test(id) ? `gid://shopify/Product/${id}` : id);

function parse(raw: AuthoringUpsellReward): AuthoringResult<ParsedUpsell> {
  const parsed = AuthoringUpsellRewardSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue?.message ?? "Invalid upsell reward.", issue?.path.join("."));
  }
  const input = parsed.data;
  if (input.discountType === "percentage" && input.discountValue > 100) {
    return fail("Discount value must be at most 100.", "discountValue");
  }
  if (input.forPublish && input.upsellProducts.length === 0) {
    return fail("Select at least one upsell product before publishing.", "upsellProducts");
  }
  if (input.forPublish && ["product", "product_selected", "product_except"].includes(input.triggerType) && input.triggerProducts.length === 0) {
    return fail("Select at least one trigger product before publishing.", "triggerProducts");
  }
  return { ok: true, value: input };
}

function single(inputs: AuthoringUpsellReward[]): AuthoringResult<ParsedUpsell> {
  if (inputs.length !== 1) return fail("An upsell offer has exactly one upsell_discount reward.", "rewards");
  return parse(inputs[0]!);
}

export const toStoredUpsellRewards: ToStored<AuthoringUpsellReward[], StoredReward[]> = async (inputs, deps) => {
  const parsed = single(inputs);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const selection = await resolveSelection(deps.db, deps.shopId, input.upsellProducts.map(toGid), input.upsellWholeProducts.map(toGid));
  const amount =
    input.template === "fbt" && !input.discountEnabled
      ? 0
      : input.discountType === "percentage"
        ? input.discountValue
        : toStoredAmount(input.discountValue, deps.shopCurrency);
  const value = { amount, currencyCode: deps.shopCurrency };
  const target = {
    ...(input.subscriptionMode === "any" ? {} : { subscriptionMode: input.subscriptionMode }),
    scopeMode: "sitewide",
    scope: "cart",
    productIds: selection.productIds,
    variantIds: selection.variantIds,
    ...(selection.selectionLevel ? { selectionLevel: selection.selectionLevel } : {}),
  };
  const validation = validateRewardPayload("upsell_discount", input.discountType, value, target);
  if (!validation.success) {
    return fail(validation.error.issues[0]?.message ?? "Invalid upsell discount configuration.", "discountValue");
  }
  return {
    ok: true,
    value: [
      {
        rewardType: "upsell_discount",
        discountType: input.discountType,
        value,
        target,
        isAutoAdd: false,
        isCustomerSelectable: true,
        trackMode: "product",
        sortOrder: 0,
      },
    ],
  };
};

/**
 * Main + visibility + (user subconditions, passed already stored) + exclude rows, in the wizard's order and sortOrder.
 * `subconditions` are the caller's normalized sub rows; their sortOrder is reassigned to index + 2 like the wizard does.
 */
export function toStoredUpsellConditions(
  inputs: AuthoringUpsellReward[],
  _deps: AuthoringDeps,
  subconditions: StoredCondition[] = [],
): AuthoringResult<StoredCondition[]> {
  const parsed = single(inputs);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const triggers = input.triggerProducts.map(toGid);
  const hasPositiveTrigger = ["product", "product_selected"].includes(input.triggerType);
  const isFbt = input.template === "fbt";
  const rows: StoredCondition[] = [
    {
      scope: "main",
      conditionType: hasPositiveTrigger ? "specific_product" : "cart_quantity",
      operator: hasPositiveTrigger ? (input.triggerMatchRule === "any" ? "any" : "gte") : "gte",
      value: hasPositiveTrigger
        ? {
            requirements: triggers.map((id) => ({
              ...(id.includes("/ProductVariant/") ? { variantId: id } : { productId: id }),
              trackMode: id.includes("/ProductVariant/") ? "variant" : "product",
              minQuantity: 1,
            })),
            multiplyByGroups: false,
          }
        : { minQuantity: 1, includeGiftValues: false },
      sortOrder: 0,
      isEnabled: true,
    },
    {
      scope: "visibility",
      conditionType: "sales_channels",
      operator: "eq",
      value: {
        upsellType: input.template,
        triggerType: input.triggerType,
        upsellMethod: input.upsellMethod,
        ...(isFbt ? { widgetType: input.widgetType } : {}),
        ...(input.template === "checkout" ? { checkoutTarget: input.checkoutTarget ?? null } : {}),
        ...(isFbt
          ? {
              allowCustomerQty: input.allowCustomerQty,
              discountEnabled: input.discountEnabled,
              discountMinProducts: input.discountMinProducts,
              discountApplyTo: input.discountApplyTo,
            }
          : {}),
      },
      sortOrder: 1,
      isEnabled: true,
    },
    ...subconditions.map((c, index): StoredCondition => ({ ...c, scope: "sub", sortOrder: index + 2, isEnabled: true })),
  ];
  if (input.triggerType === "product_except") {
    rows.push({
      scope: "sub",
      conditionType: "exclude_products",
      operator: "in",
      value: {
        productIds: triggers.filter((id) => id.includes("/Product/")),
        variantIds: triggers.filter((id) => id.includes("/ProductVariant/")),
      },
      sortOrder: subconditions.length + 2,
      isEnabled: true,
    });
  }
  return { ok: true, value: rows };
}

export function upsellCombinationPolicy(
  input: Pick<ParsedUpsell, "combinesWithOrderDiscounts" | "combinesWithShippingDiscounts">,
): StoredCombinationPolicy {
  return {
    combinesWithOrderDiscounts: input.combinesWithOrderDiscounts ?? true,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: input.combinesWithShippingDiscounts ?? true,
    combinesWithOtherAppOffers: true,
    stopLowerPriority: false,
    giftValueCountsForOtherOffers: false,
  };
}

/** The upsell wizard writes nothing besides reward, conditions and policy, so there is nothing to add after the insert. */
export function upsellAfterInsert(
  _inputs: AuthoringUpsellReward[],
  _deps: AuthoringDeps,
): (tx: unknown, offerId: string) => Promise<void> {
  return async () => {};
}
