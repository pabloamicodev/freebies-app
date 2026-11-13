/**
 * Reference model of the discount Function's reward targeting: how many units of each cart line an offer discounts,
 * driven by the offer's compiled config. Shared by the parity fixtures (parity.test.ts, which the Rust side also
 * runs against the real Function) and the MCP cart preview, so both mirror the Function the same way.
 */
import { lineMatchesPageConditions } from "./page-match.js";

export interface ReferenceLine {
  id: string;
  variantId: string;
  productId: string;
  quantity: number;
  /** Decimal string in major units. */
  unitPrice: string;
  lineType: "gift" | "upsell" | null;
  metadata: Record<string, string> | null;
}
export interface ReferenceTier {
  minimumQuantity: number;
  maximumQuantity?: number;
  discountedQuantity?: number;
  discountType?: string;
  discountValue?: number;
}
export interface ReferenceReward {
  id: string;
  targetProductIds?: string[];
  targetVariantIds?: string[];
  maxQuantity?: number;
  selectable?: boolean;
  selectionCount?: number;
  maxUnitsTotal?: number;
  discountType?: string;
  discountValue?: number;
  quantityTiers?: ReferenceTier[];
  priceTiers?: Array<{ quantity: number; targetPricePerUnit?: number }>;
  scopeMode?: string;
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds?: string[];
  requiredAnchorMinQuantity?: number;
  requiredOfferId?: string;
}
export interface ReferenceConfigOffer {
  id: string;
  mpc?: number;
  mpu?: number;
  ri?: true;
  requirements?: Array<{ productId?: string; variantId?: string; trackMode: string; minQuantity: number }>;
  excludedProductIds?: string[];
  restrictToMatchedLines?: boolean;
  giftRewards?: ReferenceReward[];
  productRewards?: ReferenceReward[];
}
/** Optional observers: what the reference model decided, for explanations. They never change the result. */
export interface ReferenceTrace {
  gift?: (info: { rewardId: string; lineId: string; units: number }) => void;
  productReward?: (info: {
    rewardId: string;
    eligibleQuantity: number;
    quantityTier?: ReferenceTier;
    priceTier?: { quantity: number; targetPricePerUnit?: number };
    unitsByLine: Record<string, number>;
  }) => void;
}

export function propertiesOf(line: ReferenceLine): Record<string, string> {
  return { ...(line.metadata ?? {}), ...(line.lineType ? { _promo_engine_line_type: line.lineType } : {}) };
}

const capByCart = (config: ReferenceConfigOffer, limit: number) => (config.mpc === undefined ? limit : Math.min(limit, config.mpc));

/** Quiz bundles: complete groups in bundle-id order, at most mpc of them, every paid line of a group discounted. */
function quizBundles(lines: readonly ReferenceLine[], config: ReferenceConfigOffer, reward: ReferenceReward, result: Record<string, number>): void {
  const groups = new Map<string, ReferenceLine[]>();
  for (const line of lines) {
    const id = line.metadata?.["_quiz_bundle_id"];
    if (id) groups.set(id, [...(groups.get(id) ?? []), line]);
  }
  let bundles = 0;
  for (const id of [...groups.keys()].sort()) {
    const paid = groups.get(id)!.filter((line) => line.metadata?.["_quiz_free_gift"] !== "true");
    const expected = Number(paid[0]?.metadata?.["_quiz_expected_paid_count"]);
    if (!(paid.length >= expected)) continue;
    if (config.mpc !== undefined && bundles >= config.mpc) break;
    bundles += 1;
    const current = paid.reduce((sum, line) => sum + Number(line.unitPrice) * line.quantity, 0);
    if (current - (reward.discountValue ?? 0) <= 0) continue;
    for (const line of paid) result[line.id] = line.quantity;
  }
}

/** Units of each line the offer discounts, following the Function's targeting rules. */
export function referenceDiscounts(
  lines: readonly ReferenceLine[],
  offer: { id: string; conditions: Array<{ conditionType: string; value: unknown }> },
  config: ReferenceConfigOffer,
  lockedGiftRewards: ReadonlySet<string> = new Set(),
  trace: ReferenceTrace = {},
): Record<string, number> {
  const excluded = new Set(config.excludedProductIds ?? []);
  const restrict = config.restrictToMatchedLines === true;
  const pageConditions = offer.conditions;
  const matches = (line: ReferenceLine) => lineMatchesPageConditions(propertiesOf(line), pageConditions);
  const result: Record<string, number> = {};
  const nonGift = lines.filter((line) => line.lineType !== "gift");

  // Every limit is the number of times a reward's gift SET is granted: each target product (each
  // target variant, for variant-targeted landing/tagged rewards) gets at most `limit` free units,
  // however high the shopper raises a quantity or however many anchors are present.
  const giftRewards = (config.giftRewards ?? []).filter((reward) => !lockedGiftRewards.has(reward.id));
  const givenByProduct: Record<string, Record<string, number>> = {};
  const remainingForReward: Record<string, number> = {};
  for (const reward of giftRewards) {
    givenByProduct[reward.id] = {};
    // A picker (choose K of N) grants selectionCount x limit units across ALL its gifts; the lines
    // the shopper added first (cart order) get them.
    remainingForReward[reward.id] = reward.selectable
      ? (reward.selectionCount ?? 1) * capByCart(config, reward.maxQuantity ?? 1)
      : Number.POSITIVE_INFINITY;
  }
  const grant = (line: ReferenceLine, reward: ReferenceReward, quantity: number): boolean => {
    const given = givenByProduct[reward.id]![line.productId] ?? 0;
    const units = Math.min(quantity, capByCart(config, reward.maxQuantity ?? 1) - given, remainingForReward[reward.id]!);
    if (units <= 0) return false;
    givenByProduct[reward.id]![line.productId] = given + units;
    remainingForReward[reward.id]! -= units;
    result[line.id] = units;
    trace.gift?.({ rewardId: reward.id, lineId: line.id, units });
    return true;
  };
  const targetsVariant = (reward: ReferenceReward, line: ReferenceLine) =>
    (reward.targetVariantIds ?? []).length === 0 || reward.targetVariantIds!.includes(line.variantId);
  // Tagged lines claim the quota first, then untagged lines (a theme adding the gift itself) fill it.
  // Units that qualify the offer (anchor) never count, and an untagged line serves one reward only.
  for (const reward of giftRewards) {
    for (const line of lines) {
      if (line.lineType !== "gift") continue;
      const metadata = line.metadata ?? {};
      if (metadata["_promo_engine_offer_id"] !== offer.id || metadata["_promo_engine_reward_id"] !== reward.id) continue;
      if (targetsVariant(reward, line)) grant(line, reward, line.quantity);
    }
  }
  for (const line of nonGift.filter((candidate) => !candidate.metadata?.["_promo_engine_offer_id"])) {
    const reserved = Math.max(
      0,
      ...(config.requirements ?? [])
        .filter((requirement) => (requirement.trackMode === "variant" ? requirement.variantId === line.variantId : requirement.productId === line.productId))
        .map((requirement) => requirement.minQuantity),
    );
    for (const reward of giftRewards) {
      if ((reward.targetVariantIds ?? []).includes(line.variantId) && grant(line, reward, line.quantity - reserved)) break;
    }
  }

  for (const reward of config.productRewards ?? []) {
    if (reward.scopeMode === "quiz_bundle") {
      quizBundles(lines, config, reward, result);
      continue;
    }
    const landing = reward.scopeMode === "landing";
    const setScoped = landing || reward.scopeMode === "tagged_offer";
    if (landing) {
      const anchorQuantity = nonGift
        .filter((line) => Number(line.unitPrice) > 0)
        .filter((line) => line.metadata?.["__landing_source"] === reward.requiredLineAttributeValue)
        .filter((line) => (reward.requiredAnchorVariantIds ?? []).includes(line.variantId))
        .reduce((sum, line) => sum + line.quantity, 0);
      if (anchorQuantity < (reward.requiredAnchorMinQuantity ?? 1)) continue;
    }
    const eligible = nonGift
      .filter((line) => Number(line.unitPrice) > 0) // a $0 line (another app's gift) is not a paid unit
      .filter((line) => !excluded.has(line.productId))
      .filter((line) => !restrict || matches(line))
      .filter((line) => !landing || line.metadata?.["__landing_source"] === reward.requiredLineAttributeValue)
      .filter((line) => reward.scopeMode !== "tagged_offer" || line.metadata?.["_promo_engine_offer_id"] === reward.requiredOfferId)
      .filter((line) => {
        const products = reward.targetProductIds ?? [];
        const variants = reward.targetVariantIds ?? [];
        return (products.length === 0 && variants.length === 0) || products.includes(line.productId) || variants.includes(line.variantId);
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const total = eligible.reduce((sum, line) => sum + line.quantity, 0);
    const quantityTier = (reward.quantityTiers ?? [])
      .filter((tier) => total >= tier.minimumQuantity && (tier.maximumQuantity === undefined || total <= tier.maximumQuantity))
      .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];
    const priceTier = (reward.priceTiers ?? []).filter((tier) => total >= tier.quantity).sort((a, b) => b.quantity - a.quantity)[0];
    if ((reward.quantityTiers ?? []).length > 0 && !quantityTier) continue;
    if ((reward.priceTiers ?? []).length > 0 && !priceTier) continue;
    const limit = capByCart(config, reward.maxQuantity ?? 1);
    const byVariant = (reward.targetVariantIds ?? []).length > 0;
    const given: Record<string, number> = {};
    let remainingTotal =
      quantityTier?.discountedQuantity ??
      reward.maxUnitsTotal ??
      (setScoped ? Number.POSITIVE_INFINITY : (reward.maxQuantity ?? Number.POSITIVE_INFINITY));
    // Per cart: one application is a unit, or one pack of the matched tier; set-scoped limits were capped above.
    if (config.mpc !== undefined && !setScoped) {
      const pack = quantityTier ? (quantityTier.discountedQuantity ?? quantityTier.minimumQuantity) : (priceTier?.quantity ?? 1);
      remainingTotal = Math.min(remainingTotal, config.mpc * pack);
    }
    const unitsByLine: Record<string, number> = {};
    for (const line of eligible) {
      const key = byVariant ? line.variantId : line.productId;
      let units = Math.min(line.quantity, remainingTotal);
      if (setScoped) units = Math.min(units, limit - (given[key] ?? 0));
      if (units <= 0) continue;
      given[key] = (given[key] ?? 0) + units;
      remainingTotal -= units;
      result[line.id] = (result[line.id] ?? 0) + units;
      unitsByLine[line.id] = units;
    }
    trace.productReward?.({
      rewardId: reward.id,
      eligibleQuantity: total,
      ...(quantityTier ? { quantityTier } : {}),
      ...(priceTier ? { priceTier } : {}),
      unitsByLine,
    });
  }
  return result;
}
