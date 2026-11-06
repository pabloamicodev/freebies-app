import { resolveCartLabels } from "./cart-labels.js";

export const QUANTITY_TIER_DISCOUNT_TYPES = ["percentage", "fixed_amount", "fixed_price", "free"] as const;
type TierDiscountType = (typeof QUANTITY_TIER_DISCOUNT_TYPES)[number];

export interface QuantityTier {
  minimumQuantity: number;
  maximumQuantity?: number;
  discountType: TierDiscountType;
  discountValue: number;
  discountedQuantity?: number;
  label?: string;
  cartLabels?: string[];
}

export type QuantityTiersResult = { ok: true; tiers: QuantityTier[] } | { ok: false; error: string };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** Same rules as the volume wizard: whole quantities from 1, ascending and non-overlapping, value >= 0, labels via resolveCartLabels. */
export function parseQuantityTiers(raw: unknown): QuantityTiersResult {
  let input = raw;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Quantity tiers must be valid JSON." };
    }
  }
  if (!Array.isArray(input)) return { ok: false, error: "Quantity tiers are invalid." };
  const tiers: QuantityTier[] = [];
  for (const [index, entry] of input.entries()) {
    const n = index + 1;
    if (!entry || typeof entry !== "object") return { ok: false, error: `Tier ${n} is invalid.` };
    const tier = entry as Record<string, unknown>;
    const { minimumQuantity, maximumQuantity, discountType, discountValue, discountedQuantity } = tier;
    if (!isCount(minimumQuantity)) return { ok: false, error: `Tier ${n}: minimum quantity must be a whole number of at least 1.` };
    if (maximumQuantity !== undefined && maximumQuantity !== null && (!isCount(maximumQuantity) || maximumQuantity < minimumQuantity)) {
      return { ok: false, error: `Tier ${n}: maximum quantity must be a whole number greater than or equal to its minimum.` };
    }
    if (!QUANTITY_TIER_DISCOUNT_TYPES.includes(discountType as TierDiscountType)) return { ok: false, error: `Tier ${n}: discount type is invalid.` };
    if (typeof discountValue !== "number" || !Number.isFinite(discountValue) || discountValue < 0) {
      return { ok: false, error: `Tier ${n}: discount value must be a number of 0 or more.` };
    }
    if (discountType === "percentage" && discountValue > 100) return { ok: false, error: `Tier ${n}: percentage cannot exceed 100%.` };
    if (discountedQuantity !== undefined && discountedQuantity !== null && !isCount(discountedQuantity)) {
      return { ok: false, error: `Tier ${n}: discounted quantity must be a whole number of at least 1.` };
    }
    const label = typeof tier["label"] === "string" ? tier["label"].trim() : "";
    if (Array.from(label).length > 120) return { ok: false, error: `Tier ${n}: title cannot exceed 120 characters.` };
    const labels = resolveCartLabels(tier["cartLabels"]);
    if (!labels.ok) return { ok: false, error: `Tier ${n}: ${labels.error}` };
    const previous = tiers[tiers.length - 1];
    if (previous && (previous.maximumQuantity === undefined || minimumQuantity <= previous.maximumQuantity)) {
      return { ok: false, error: `Tier ${n} overlaps the tier before it: tiers must be in ascending order without overlapping quantities.` };
    }
    tiers.push({
      minimumQuantity,
      ...(isCount(maximumQuantity) ? { maximumQuantity } : {}),
      discountType: discountType as TierDiscountType,
      discountValue,
      ...(isCount(discountedQuantity) ? { discountedQuantity } : {}),
      ...(label ? { label } : {}),
      ...(labels.labels.length > 0 ? { cartLabels: labels.labels } : {}),
    });
  }
  return { ok: true, tiers };
}
