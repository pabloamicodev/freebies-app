import { z } from "zod";
import { DiscountTypeSchema, validateRewardPayload, type DiscountType } from "@promo/shared-types";
import { buildTieredGiftOffer, giftTierModeSchema, type GiftTierMode } from "./gift-tier-campaigns.js";

export const TIER_MODE_COLUMN = "gift_tier_mode";
export const TIER_THRESHOLD_COLUMN = "gift_min_cart_subtotal_cents";
export const SHOP_CURRENCY_COLUMN = "shop_currency_code";

const blankTo = <T>(fallback: T) => (value: unknown) => (value === "" ? fallback : value);
const positiveInt = z.string().regex(/^\d+$/, "must be a positive whole number").transform(Number).pipe(z.number().int().positive().max(1_000_000_000));
const variantGid = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "must be Shopify variant GIDs separated by |");

const tierRowSchema = z.object({
  threshold: z.preprocess((value) => (value === "" ? null : value), positiveInt.nullable()),
  mode: z.preprocess(blankTo("cumulative"), giftTierModeSchema),
  quantity: z.preprocess(blankTo("1"), positiveInt.pipe(z.number().max(20))),
  variantIds: z.array(variantGid).min(1),
  fallbackVariantIds: z.array(variantGid).max(5),
  discountType: z.preprocess(blankTo("free"), DiscountTypeSchema),
  rewardValue: z.preprocess(blankTo(""), z.string().refine((raw) => raw === "" || Number.isFinite(Number(raw)), "must be a number")),
  isAutoAdd: z.preprocess(blankTo(null), z.enum(["true", "false"]).nullable()),
  trackMode: z.preprocess(blankTo("variant"), z.enum(["product", "variant"])),
});

const tierGroupSchema = z.array(tierRowSchema).min(1).max(40).superRefine((rows, ctx) => {
  const seen = new Set<number>();
  const firstTier = rows.find((row) => row.threshold !== null);
  rows.forEach((row, index) => {
    if (row.threshold === null) return;
    if (row.mode !== firstTier!.mode) ctx.addIssue({ code: "custom", path: [index, "mode"], message: `${TIER_MODE_COLUMN} must be the same on every row of an offer` });
    if (seen.has(row.threshold)) ctx.addIssue({ code: "custom", path: [index, "threshold"], message: "tier thresholds must be unique" });
    seen.add(row.threshold);
  });
  if (seen.size > 20) ctx.addIssue({ code: "custom", path: [0, "threshold"], message: "an offer can have at most 20 tiers" });
});

const COLUMN_OF: Record<string, string> = {
  threshold: TIER_THRESHOLD_COLUMN,
  mode: TIER_MODE_COLUMN,
  quantity: "gift_quantity",
  variantIds: "gift_variant_gids",
  fallbackVariantIds: "gift_fallback_variant_gids",
  discountType: "discount_type",
  rewardValue: "reward_value",
  isAutoAdd: "is_auto_add",
  trackMode: "track_mode",
};

const split = (raw: string | undefined) => (raw ? raw.split("|").map((gid) => gid.trim()).filter(Boolean) : []);
const rowKey = (row: Record<string, string>): string | null => (row["type"] === "gift" ? row["offer_id"] || row["internal_name"] || null : null);

/**
 * Rows of one tiered gift offer: every gift row sharing an offer_id (internal_name when absent) with any row that carries a
 * tier threshold, so a gift without a threshold stays in its offer. Maps the first row of each group to all of its row indices.
 */
export function groupTierRows(rows: Array<Record<string, string>>): Map<number, number[]> {
  const tiered = new Set(rows.flatMap((row) => (row[TIER_THRESHOLD_COLUMN] && rowKey(row) ? [rowKey(row)!] : [])));
  const byKey = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = rowKey(row);
    if (key !== null && tiered.has(key)) byKey.set(key, [...(byKey.get(key) ?? []), index]);
  });
  return new Map([...byKey.values()].map((indices) => [indices[0]!, indices]));
}

type BuiltTieredGift = ReturnType<typeof buildTieredGiftOffer>;
export type TierGroupResult =
  | { error: string; rowIndex: number }
  | { tierMode: GiftTierMode; condition: BuiltTieredGift["condition"]; rewards: Array<Omit<BuiltTieredGift["rewards"][number], "discountType" | "value"> & { discountType: DiscountType; value: Record<string, unknown> }> };

/** Validates the rows of one tiered gift offer at the import boundary and builds its rewards and main condition. */
export function parseTierGroup(rows: Array<Record<string, string>>, currencyCode: string): TierGroupResult {
  const parsed = tierGroupSchema.safeParse(
    rows.map((row) => ({
      threshold: row[TIER_THRESHOLD_COLUMN] ?? "",
      mode: row[TIER_MODE_COLUMN] ?? "",
      quantity: row["gift_quantity"] ?? "",
      variantIds: split(row["gift_variant_gids"]),
      fallbackVariantIds: split(row["gift_fallback_variant_gids"]),
      discountType: row["discount_type"] ?? "",
      rewardValue: row["reward_value"] ?? "",
      isAutoAdd: row["is_auto_add"] ?? "",
      trackMode: row["track_mode"] ?? "",
    })),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const rowIndex = typeof issue.path[0] === "number" ? issue.path[0] : 0;
    const column = COLUMN_OF[String(issue.path[1])];
    return { error: column ? `${column} ${issue.message}` : issue.message, rowIndex };
  }

  const entries = parsed.data.map((tier, rowIndex) => ({ tier, rowIndex }));
  const tiered = entries.filter((entry) => entry.tier.threshold !== null).sort((a, b) => a.tier.threshold! - b.tier.threshold!);
  const untiered = entries.filter((entry) => entry.tier.threshold === null);
  const built = buildTieredGiftOffer(
    {
      campaignId: "imported",
      name: (rows[0]!["internal_name"] || "Imported gift tiers").slice(0, 120),
      stackingMode: tiered[0]!.tier.mode === "highest" ? "highest_tier_only" : "cumulative",
      tiers: tiered.map(({ tier }, index) => ({
        id: `tier-${index + 1}`,
        minimumSubtotalCents: tier.threshold!,
        variantIds: tier.variantIds,
        ...(tier.fallbackVariantIds.length ? { fallbackVariantIds: tier.fallbackVariantIds } : {}),
        quantity: tier.quantity,
      })),
    },
    currencyCode,
  );

  const rewards: Extract<TierGroupResult, { rewards: unknown }>["rewards"] = [];
  for (const [position, { tier, rowIndex }] of [...tiered, ...untiered].entries()) {
    const base = built.rewards[position] ?? {
      rewardType: "product_gift" as const, discountType: "free" as const, value: { amount: 100, currencyCode },
      target: { scope: "cart" as const, variantIds: tier.variantIds, ...(tier.fallbackVariantIds.length ? { fallbackVariantIds: tier.fallbackVariantIds.filter((id) => !tier.variantIds.includes(id)) } : {}) },
      quantity: tier.quantity, isAutoAdd: tier.variantIds.length === 1, isCustomerSelectable: tier.variantIds.length > 1, trackMode: "variant" as const,
      sortOrder: position, label: "Gift", minCartSubtotalCents: 0,
    };
    const amount = tier.discountType === "free" ? 100 : tier.rewardValue === "" ? 0 : Number(tier.rewardValue);
    const value = { amount, currencyCode };
    const payload = validateRewardPayload("product_gift", tier.discountType, value, base.target);
    if (!payload.success) return { error: payload.error.issues[0]?.message ?? "Invalid reward payload", rowIndex };
    const isAutoAdd = tier.isAutoAdd === null ? base.isAutoAdd : tier.isAutoAdd === "true";
    const { minCartSubtotalCents: _min, ...rest } = base;
    rewards.push({
      ...rest,
      discountType: tier.discountType,
      value,
      isAutoAdd,
      isCustomerSelectable: tier.isAutoAdd === null ? base.isCustomerSelectable : !isAutoAdd && tier.variantIds.length > 1,
      trackMode: tier.trackMode,
      sortOrder: position,
      ...(tier.threshold === null ? {} : { minCartSubtotalCents: tier.threshold }),
    } as (typeof rewards)[number]);
  }

  // An exported main threshold below the lowest tier is kept; above it the tier would be unreachable.
  const main = Number(rows[0]!["condition_value_threshold_cents"]);
  const condition =
    rows[0]!["condition_type"] === "cart_value" && Number.isInteger(main) && main > 0 && main < built.condition.thresholdCents
      ? { ...built.condition, thresholdCents: main }
      : built.condition;
  return { tierMode: built.tierMode, condition, rewards };
}
