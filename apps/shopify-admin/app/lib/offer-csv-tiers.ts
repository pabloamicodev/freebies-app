import { z } from "zod";
import { buildTieredGiftOffer, giftTierModeSchema, type GiftTierMode } from "./gift-tier-campaigns.js";

export const TIER_MODE_COLUMN = "gift_tier_mode";
export const TIER_THRESHOLD_COLUMN = "gift_min_cart_subtotal_cents";

const positiveInt = z.string().regex(/^\d+$/, "must be a positive whole number").transform(Number).pipe(z.number().int().positive().max(1_000_000_000));
const variantGid = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "must be Shopify variant GIDs separated by |");

const tierRowSchema = z.object({
  threshold: positiveInt,
  mode: z.preprocess((value) => (value === "" ? "cumulative" : value), giftTierModeSchema),
  quantity: z.preprocess((value) => (value === "" ? "1" : value), positiveInt.pipe(z.number().max(20))),
  variantIds: z.array(variantGid).min(1),
  fallbackVariantIds: z.array(variantGid).max(5),
});

const tierGroupSchema = z.array(tierRowSchema).min(1).max(20).superRefine((rows, ctx) => {
  const seen = new Set<number>();
  rows.forEach((row, index) => {
    if (row.mode !== rows[0]!.mode) ctx.addIssue({ code: "custom", path: [index, "mode"], message: `${TIER_MODE_COLUMN} must be the same on every row of an offer` });
    if (seen.has(row.threshold)) ctx.addIssue({ code: "custom", path: [index, "threshold"], message: "tier thresholds must be unique" });
    seen.add(row.threshold);
  });
});

const COLUMN_OF: Record<string, string> = {
  threshold: TIER_THRESHOLD_COLUMN,
  mode: TIER_MODE_COLUMN,
  quantity: "gift_quantity",
  variantIds: "gift_variant_gids",
  fallbackVariantIds: "gift_fallback_variant_gids",
};

const split = (raw: string | undefined) => (raw ? raw.split("|").map((gid) => gid.trim()).filter(Boolean) : []);

/** A CSV row belongs to a tiered gift when it carries a tier threshold; rows of one offer share offer_id (internal_name when absent). */
export const tierGroupKey = (row: Record<string, string>): string | null =>
  row["type"] === "gift" && row[TIER_THRESHOLD_COLUMN] ? `${row["offer_id"] || row["internal_name"] || ""}` : null;

type BuiltTieredGift = ReturnType<typeof buildTieredGiftOffer>;
export type TierGroupResult = { error: string } | { tierMode: GiftTierMode; condition: BuiltTieredGift["condition"]; rewards: BuiltTieredGift["rewards"] };

/** Validates the rows of one tiered gift offer at the import boundary and builds its rewards and main condition. */
export function parseTierGroup(rows: Array<Record<string, string>>, currencyCode: string): TierGroupResult {
  const parsed = tierGroupSchema.safeParse(
    rows.map((row) => ({
      threshold: row[TIER_THRESHOLD_COLUMN] ?? "",
      mode: row[TIER_MODE_COLUMN] ?? "",
      quantity: row["gift_quantity"] ?? "",
      variantIds: split(row["gift_variant_gids"]),
      fallbackVariantIds: split(row["gift_fallback_variant_gids"]),
    })),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const column = COLUMN_OF[String(issue.path[1])];
    return { error: column ? `${column} ${issue.message}` : issue.message };
  }
  const tiers = parsed.data;
  const built = buildTieredGiftOffer(
    {
      campaignId: "imported",
      name: (rows[0]!["internal_name"] || "Imported gift tiers").slice(0, 120),
      stackingMode: tiers[0]!.mode === "highest" ? "highest_tier_only" : "cumulative",
      tiers: tiers.map((tier, index) => ({
        id: `tier-${index + 1}`,
        minimumSubtotalCents: tier.threshold,
        variantIds: tier.variantIds,
        ...(tier.fallbackVariantIds.length ? { fallbackVariantIds: tier.fallbackVariantIds } : {}),
        quantity: tier.quantity,
      })),
    },
    currencyCode,
  );
  // An exported main threshold below the lowest tier is kept; above it the tier would be unreachable.
  const main = Number(rows[0]!["condition_value_threshold_cents"]);
  const condition =
    rows[0]!["condition_type"] === "cart_value" && Number.isInteger(main) && main > 0 && main < built.condition.thresholdCents
      ? { ...built.condition, thresholdCents: main }
      : built.condition;
  return { tierMode: built.tierMode, condition, rewards: built.rewards };
}
