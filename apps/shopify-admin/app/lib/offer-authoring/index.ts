import { z } from "zod";
import { ConditionOperatorSchema, ConditionTypeSchema, validateConditionValue } from "@promo/shared-types";
import { AuthoringDiscountRewardSchema, mainConditionForRewards, toStoredDiscountRewards } from "./rewards.js";
import type { AuthoringDeps, AuthoringResult, StoredCondition, StoredReward, ToStored } from "./types.js";

export * from "./types.js";
export { mainConditionForRewards, AuthoringDiscountRewardSchema, toStoredDiscountRewards, type AuthoringDiscountReward } from "./rewards.js";
export { AuthoringOfferFields, OFFER_TYPES, parseOfferDates, resolveOfferText, statusFor } from "./offer.js";

/**
 * Reward families. To plug a family in once its module is merged, add ONE line to REWARD_FAMILIES, e.g.
 *   gifts:     { schema: AuthoringGiftRewardSchema, toStored: toStoredGiftRewards }       from "./gifts.js"
 *   bundles:   { schema: AuthoringBundleRewardSchema, toStored: toStoredBundleRewards }   from "./bundles.js"
 *   upsells:   { schema: AuthoringUpsellRewardSchema, toStored: toStoredUpsellRewards }   from "./upsells.js"
 *   shipping:  { schema: AuthoringShippingRewardSchema, toStored: toStoredShippingRewards } from "./shipping.js"
 * Each schema is a zod object (or discriminated union) whose `kind` is the stored rewardType.
 */
type RewardFamily = {
  /** Reward kinds (stored rewardType) this family owns. */
  kinds: readonly string[];
  schema: z.ZodType<{ kind: string }>;
  // The family's input type is private to its module; the schema validates it before toStored runs.
  toStored: ToStored<any[], StoredReward[]>;
  /** Optional: the main condition the wizard derives from these rewards when the caller gives none. */
  mainCondition?: (items: any[], deps: Pick<AuthoringDeps, "shopCurrency">) => AuthoringResult<StoredCondition>;
};
export const REWARD_FAMILIES: Record<string, RewardFamily> = {
  discounts: { kinds: ["product_discount", "order_discount"], schema: AuthoringDiscountRewardSchema, toStored: toStoredDiscountRewards, mainCondition: mainConditionForRewards },
};

const familySchemas = Object.values(REWARD_FAMILIES).map((family) => family.schema);
export const AuthoringRewardSchema = z.discriminatedUnion("kind", familySchemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
export type AuthoringReward = z.input<typeof AuthoringDiscountRewardSchema>;

/** The main condition derived from the first reward by the family that owns it; null when that family derives none. */
export function deriveMainCondition(inputs: Array<{ kind: string }>, deps: Pick<AuthoringDeps, "shopCurrency">): AuthoringResult<StoredCondition> | null {
  const first = inputs[0];
  const family = first ? Object.values(REWARD_FAMILIES).find((candidate) => candidate.kinds.includes(first.kind)) : undefined;
  return family?.mainCondition ? family.mainCondition(inputs, deps) : null;
}

/** Validates and converts every authoring reward to its stored rows: families in order of first appearance, sortOrder = position. */
export const toStoredRewards: ToStored<Array<{ kind: string }>, StoredReward[]> = async (inputs, deps) => {
  const byFamily = new Map<string, Array<{ kind: string }>>();
  for (const [index, item] of inputs.entries()) {
    const family = Object.entries(REWARD_FAMILIES).find(([, candidate]) => candidate.kinds.includes(item.kind))?.[0];
    if (!family) return { ok: false, error: `rewards[${index}]: unsupported reward kind "${item.kind}".`, path: `rewards[${index}]` };
    byFamily.set(family, [...(byFamily.get(family) ?? []), item]);
  }
  const stored: StoredReward[] = [];
  for (const [name, items] of byFamily) {
    const result = await REWARD_FAMILIES[name]!.toStored(items, deps);
    if (!result.ok) return result;
    stored.push(...result.value);
  }
  return { ok: true, value: stored.map((reward, position) => ({ ...reward, sortOrder: position })) };
};

/**
 * Conditions: generic fallback until conditions.ts (package 04) is merged. At integration replace this block with
 *   export { AuthoringConditionSchema, toStoredConditions } from "./conditions.js";
 * and the same for codes (package 08):
 *   export { AuthoringCodesSchema, createCodesForOffer } from "./codes.js";
 */
export const AuthoringConditionSchema = z.strictObject({
  type: ConditionTypeSchema.describe("Condition type, e.g. cart_value, cart_quantity, customer_tags, markets, page_types, specific_product."),
  scope: z.enum(["main", "sub"]).default("sub").describe("main: the eligibility gate (an offer needs at least one to publish; one is derived from the rewards when omitted). sub: an additional restriction."),
  operator: ConditionOperatorSchema.default("eq").describe("Comparison operator; most conditions use eq, thresholds use gte."),
  value: z.record(z.string(), z.unknown()).describe("The condition's value object, validated against the type's schema (money fields in stored minor units, e.g. thresholdCents)."),
  enabled: z.boolean().default(true),
});
export type AuthoringCondition = z.input<typeof AuthoringConditionSchema>;

export const toStoredConditions: ToStored<AuthoringCondition[], StoredCondition[]> = async (inputs) => {
  const out: StoredCondition[] = [];
  for (const [index, raw] of inputs.entries()) {
    const parsed = AuthoringConditionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `conditions[${index}]: ${parsed.error.issues[0]?.message ?? "invalid condition"}`, path: `conditions[${index}]` };
    const condition = parsed.data;
    const valid = validateConditionValue(condition.type, condition.value);
    if (!valid.success) return { ok: false, error: `conditions[${index}] (${condition.type}): ${valid.error.issues[0]?.message ?? "invalid value"}`, path: `conditions[${index}]` };
    out.push({ scope: condition.scope, conditionType: condition.type, operator: condition.operator, value: condition.value, sortOrder: index, isEnabled: condition.enabled });
  }
  return { ok: true, value: out };
};
