import type { Offer, OfferCombinationPolicy, OfferCondition, OfferReward } from "@promo/db";

/**
 * DC7 split on stored rows: an oversize product reward becomes k offers that each target a disjoint slice of its
 * products and variants. Only offers whose discount can never grow when fewer items count together qualify, so every
 * line gets at most the discount it gets today (each line belongs to exactly one part).
 */
export interface SplitRows {
  offer: Pick<Offer, "requiresCode" | "requiredDiscountCode">;
  rewards: readonly OfferReward[];
  conditions: readonly Pick<OfferCondition, "conditionType" | "isEnabled">[];
  policy: Pick<OfferCombinationPolicy, "stopLowerPriority" | "maxApplicationsPerCart" | "maxApplicationsPerCustomer"> | null;
}

export type SplitEligibility = { ok: true; reward: OfferReward } | { ok: false; why: string };

const PRODUCT_REWARDS = new Set(["product_discount", "upsell_discount"]);
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
const set = (value: unknown) => value !== undefined && value !== null;

function tiersTighten(reward: OfferReward): boolean {
  const value = asRecord(reward.value);
  const target = asRecord(reward.target);
  const quantityTiers = Array.isArray(value["tiers"]) ? value["tiers"].map(asRecord) : [];
  const priceTiers = Array.isArray(target["priceTiers"]) ? target["priceTiers"].map(asRecord) : [];
  if ((quantityTiers.length === 0) === (priceTiers.length === 0)) return false;
  if (Number(value["amount"] ?? 0) !== 0) return false;
  if (quantityTiers.length > 0) {
    const sorted = [...quantityTiers].sort((a, b) => Number(a["minimumQuantity"]) - Number(b["minimumQuantity"]));
    const type = sorted[0]?.["discountType"];
    if (type !== "percentage" && type !== "fixed_amount") return false;
    return sorted.every(
      (tier, index) =>
        tier["discountType"] === type &&
        !set(tier["maximumQuantity"]) &&
        !set(tier["discountedQuantity"]) &&
        Number.isFinite(Number(tier["discountValue"])) &&
        (index === 0 || Number(tier["discountValue"]) >= Number(sorted[index - 1]!["discountValue"])),
    );
  }
  const sorted = [...priceTiers].sort((a, b) => Number(a["quantity"]) - Number(b["quantity"]));
  return sorted.every(
    (tier, index) => Number.isFinite(Number(tier["targetPricePerUnit"])) && (index === 0 || Number(tier["targetPricePerUnit"]) <= Number(sorted[index - 1]!["targetPricePerUnit"])),
  );
}

export function splitEligibility(rows: SplitRows): SplitEligibility {
  if (rows.offer.requiresCode || rows.offer.requiredDiscountCode) return { ok: false, why: "code offer" };
  if (rows.policy?.stopLowerPriority) return { ok: false, why: "stops lower-priority offers" };
  if (rows.policy?.maxApplicationsPerCart != null || rows.policy?.maxApplicationsPerCustomer != null) return { ok: false, why: "application limits" };
  if (rows.conditions.some((condition) => condition.isEnabled && condition.conditionType === "one_use_per_customer")) return { ok: false, why: "usage limit" };
  if (rows.rewards.length !== 1) return { ok: false, why: "more than one reward" };
  const reward = rows.rewards[0]!;
  if (!PRODUCT_REWARDS.has(reward.rewardType)) return { ok: false, why: "not a product discount" };
  if (reward.discountType === "cheapest_item_free" || reward.discountType === "most_expensive_item_discount") return { ok: false, why: "cheapest or most expensive item" };
  if (reward.quantity) return { ok: false, why: "quantity cap" };
  const target = asRecord(reward.target);
  if (target["selectionMode"] === "cheapest" || target["selectionMode"] === "most_expensive") return { ok: false, why: "selection mode" };
  if (target["scopeMode"] !== undefined && target["scopeMode"] !== "sitewide") return { ok: false, why: "landing or quiz scope" };
  if (set(target["maxUnitsTotal"]) || set(target["maxUnitsPerProduct"])) return { ok: false, why: "unit cap" };
  if (set(target["requiredOfferId"]) || set(target["requiredLineAttribute"]) || set(target["requiredLineAttributeValue"]) || ids(target["requiredAnchorVariantIds"]).length > 0) return { ok: false, why: "linked offer" };
  if (!tiersTighten(reward)) return { ok: false, why: "tiers can grow when split" };
  if (ids(target["productIds"]).length + ids(target["variantIds"]).length < 2) return { ok: false, why: "nothing to split" };
  return { ok: true, reward };
}

/** Disjoint, contiguous, near-equal slices of the reward's products then variants; `k` is capped by the item count. */
export function sliceTarget(target: unknown, k: number): Array<Record<string, unknown>> {
  const base = asRecord(target);
  const productIds = ids(base["productIds"]);
  const variantIds = ids(base["variantIds"]);
  const total = productIds.length + variantIds.length;
  const parts = Math.max(1, Math.min(k, total));
  const size = Math.ceil(total / parts);
  const slices: Array<Record<string, unknown>> = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    const products = productIds.slice(Math.min(start, productIds.length), Math.min(end, productIds.length));
    const variants = variantIds.slice(Math.max(0, start - productIds.length), Math.max(0, end - productIds.length));
    const { productIds: _p, variantIds: _v, selectionLevel: _s, ...rest } = base;
    slices.push({
      ...rest,
      ...(products.length > 0 ? { productIds: products } : {}),
      ...(variants.length > 0 ? { variantIds: variants } : {}),
      ...(products.length > 0 && variants.length === 0 && base["selectionLevel"] === "product" ? { selectionLevel: "product" } : {}),
    });
  }
  return slices;
}

export const partName = (name: string, index: number, parts: number) => `${name} (${index + 1}/${parts})`;
