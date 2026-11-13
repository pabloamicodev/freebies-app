import { z } from "zod";
import { AuthoringBundleRewardSchema, bundleAfterInsert, bundleCombinationPolicy, bundleMainCondition, toStoredBundleRewards, type AuthoringBundleReward } from "./bundles.js";
import { AuthoringGiftRewardSchema, giftMainCondition, toStoredGiftRewards, type AuthoringGiftReward, type AuthoringGiftTrigger } from "./gifts.js";
import { AuthoringDiscountRewardSchema, mainConditionForRewards, toStoredDiscountRewards, type AuthoringDiscountReward } from "./rewards.js";
import {
  SHIPPING_COMBINATION_POLICY,
  AuthoringShippingRewardSchema,
  shippingMainConditionFromAuthoring,
  toStoredShippingRewards,
  type AuthoringShippingReward,
} from "./shipping.js";
import {
  AuthoringUpsellRewardSchema,
  toStoredUpsellConditions,
  toStoredUpsellRewards,
  upsellAfterInsert,
  upsellCombinationPolicy,
  type AuthoringUpsellReward,
} from "./upsells.js";
import type { AuthoringDeps, AuthoringResult, StoredCombinationPolicy, StoredCondition, StoredReward, ToStored } from "./types.js";

export * from "./types.js";
export { mainConditionForRewards, AuthoringDiscountRewardSchema, toStoredDiscountRewards, type AuthoringDiscountReward } from "./rewards.js";
export { AuthoringOfferFields, OFFER_TYPES, parseOfferDates, resolveOfferText, statusFor } from "./offer.js";
export { AuthoringConditionSchema, toStoredConditions, type AuthoringCondition } from "./conditions.js";
export { AuthoringCodesSchema, createCodesForOffer, type AuthoringCodes } from "./codes.js";
export { AuthoringGiftTriggerSchema, type AuthoringGiftTrigger } from "./gifts.js";

/** Inputs a family may need besides its own rewards. */
export type FamilyContext = {
  /** What the offer is requested as: bundles and upsells apply their publish-time checks only for "active". */
  status: "draft" | "active";
  /** Gift offers: the explicit trigger (main condition). */
  trigger?: AuthoringGiftTrigger | undefined;
};

type AfterInsertTx = Parameters<Parameters<AuthoringDeps["db"]["transaction"]>[0]>[0];

type RewardFamily = {
  /** Reward kinds (stored rewardType) this family owns. */
  kinds: readonly string[];
  schema: z.core.$ZodTypeDiscriminable;
  // The family's input type is private to its module; the schema validates it before toStored runs.
  toStored: ToStored<any[], StoredReward[]>;
  /** The main condition the wizard derives from these rewards when the caller gives none. */
  mainCondition?: (items: any[], deps: AuthoringDeps, ctx: FamilyContext) => AuthoringResult<StoredCondition>;
  /** Combination policy the family's wizard stores (applied under the caller's explicit `combinations`). */
  combinationPolicy?: (items: any[]) => StoredCombinationPolicy;
  /** Extra rows the wizard writes inside the create transaction (bundle definitions/steps/tiers; swaps the offer-id placeholder). MANDATORY for bundles. */
  afterInsert?: (items: any[], deps: AuthoringDeps) => (tx: AfterInsertTx, offerId: string) => Promise<void>;
  /** Builds the family's COMPLETE condition list from the caller's non-main conditions (upsell: main + visibility + subconditions + exclude). Replaces the derived main condition. */
  extraConditions?: (items: any[], deps: AuthoringDeps, given: StoredCondition[]) => AuthoringResult<StoredCondition[]>;
  /** The reward input has a `forPublish` flag that turns on the wizard's publish-time checks; set when the offer is requested active. */
  forPublish?: boolean;
};

export const REWARD_FAMILIES: Record<string, RewardFamily> = {
  discounts: { kinds: ["product_discount", "order_discount"], schema: AuthoringDiscountRewardSchema, toStored: toStoredDiscountRewards, mainCondition: mainConditionForRewards },
  gifts: {
    kinds: ["product_gift"],
    schema: AuthoringGiftRewardSchema,
    toStored: toStoredGiftRewards,
    mainCondition: (items: AuthoringGiftReward[], deps, ctx) => giftMainCondition(items, ctx.trigger, deps),
  },
  bundles: {
    kinds: ["bundle_discount"],
    schema: AuthoringBundleRewardSchema,
    toStored: toStoredBundleRewards,
    mainCondition: (items: AuthoringBundleReward[], deps) => bundleMainCondition(items, deps),
    combinationPolicy: (items: AuthoringBundleReward[]) => bundleCombinationPolicy({ combinesWithOrderDiscounts: items[0]?.combinesWithOrderDiscounts ?? false, combinesWithShippingDiscounts: items[0]?.combinesWithShippingDiscounts ?? false }),
    afterInsert: (items: AuthoringBundleReward[], deps) => bundleAfterInsert(items, deps),
    forPublish: true,
  },
  upsells: {
    kinds: ["upsell_discount"],
    schema: AuthoringUpsellRewardSchema,
    toStored: toStoredUpsellRewards,
    extraConditions: (items: AuthoringUpsellReward[], deps, given) =>
      toStoredUpsellConditions(items, deps, given.filter((condition) => condition.scope === "sub" || condition.scope === "quantity_limit")),
    combinationPolicy: (items: AuthoringUpsellReward[]) => upsellCombinationPolicy({ combinesWithOrderDiscounts: items[0]?.combinesWithOrderDiscounts ?? true, combinesWithShippingDiscounts: items[0]?.combinesWithShippingDiscounts ?? true }),
    afterInsert: (items: AuthoringUpsellReward[], deps) => upsellAfterInsert(items, deps) as (tx: AfterInsertTx, offerId: string) => Promise<void>,
    forPublish: true,
  },
  shipping: {
    kinds: ["shipping_discount"],
    schema: AuthoringShippingRewardSchema,
    toStored: (items: AuthoringShippingReward[], deps) =>
      items.length === 1 ? toStoredShippingRewards(items[0]!, deps) : Promise.resolve({ ok: false as const, error: "A shipping offer has exactly one shipping_discount reward.", path: "rewards" }),
    mainCondition: (items: AuthoringShippingReward[], deps) => ({ ok: true, value: shippingMainConditionFromAuthoring(items[0]!, deps.shopCurrency) }),
    combinationPolicy: () => SHIPPING_COMBINATION_POLICY,
  },
};

const familySchemas = Object.values(REWARD_FAMILIES).map((family) => family.schema) as [z.core.$ZodTypeDiscriminable, ...z.core.$ZodTypeDiscriminable[]];
const rewardUnion = z.discriminatedUnion("kind", familySchemas);
export type AuthoringReward =
  | AuthoringDiscountReward
  | z.input<typeof AuthoringGiftRewardSchema>
  | z.input<typeof AuthoringBundleRewardSchema>
  | z.input<typeof AuthoringUpsellRewardSchema>
  | z.input<typeof AuthoringShippingRewardSchema>;
export type ParsedAuthoringReward =
  | z.output<typeof AuthoringDiscountRewardSchema>
  | z.output<typeof AuthoringGiftRewardSchema>
  | z.output<typeof AuthoringBundleRewardSchema>
  | z.output<typeof AuthoringUpsellRewardSchema>
  | z.output<typeof AuthoringShippingRewardSchema>;
// The union is built from the family registry, so its static type is erased; restore the precise one.
export const AuthoringRewardSchema = rewardUnion as unknown as z.ZodType<ParsedAuthoringReward, AuthoringReward>;

const familyOf = (kind: string): RewardFamily | undefined => Object.values(REWARD_FAMILIES).find((candidate) => candidate.kinds.includes(kind));

/** The family that owns the first reward (an offer's rewards are always of one family). */
export function familyOfRewards(inputs: Array<{ kind: string }>): RewardFamily | undefined {
  const first = inputs[0];
  return first ? familyOf(first.kind) : undefined;
}

/** Turns on the wizard's publish-time checks (`forPublish`) for the families that have them when the offer is requested active. */
export function withPublishIntent<T extends { kind: string }>(inputs: T[], status: "draft" | "active"): T[] {
  if (status !== "active") return inputs;
  return inputs.map((item) => (familyOf(item.kind)?.forPublish ? { ...item, forPublish: true } : item));
}

/** The main condition derived from the first reward by the family that owns it; null when that family derives none. */
export function deriveMainCondition(inputs: Array<{ kind: string }>, deps: AuthoringDeps, ctx: FamilyContext = { status: "draft" }): AuthoringResult<StoredCondition> | null {
  const family = familyOfRewards(inputs);
  return family?.mainCondition ? family.mainCondition(inputs, deps, ctx) : null;
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
