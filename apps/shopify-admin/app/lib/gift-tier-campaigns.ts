import { z } from "zod";

const variantGid = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/);

export const giftTierCampaignSchema = z.object({
  campaignId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(48),
  name: z.string().trim().min(1).max(120),
  stackingMode: z.enum(["highest_tier_only", "cumulative"]),
  tiers: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(48),
    minimumSubtotalCents: z.number().int().nonnegative(),
    variantIds: z.array(variantGid).min(1),
    quantity: z.number().int().positive().max(20),
  }).strict()).min(1).max(20),
}).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  const thresholds = new Set<number>();
  config.tiers.forEach((tier, index) => {
    if (ids.has(tier.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", index, "id"], message: "Tier IDs must be unique." });
    if (thresholds.has(tier.minimumSubtotalCents)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", index, "minimumSubtotalCents"], message: "Tier thresholds must be unique." });
    ids.add(tier.id);
    thresholds.add(tier.minimumSubtotalCents);
  });
});

export type GiftTierCampaign = z.infer<typeof giftTierCampaignSchema>;

export interface GiftTierOfferDraft {
  internalName: string;
  publicTitle: string;
  priority: number;
  condition: { thresholdCents: number; maxCents?: number; currencyCode: string; includeGiftValues: false };
  reward: {
    target: { scope: "cart"; variantIds: string[] };
    quantity: number;
    isAutoAdd: boolean;
    isCustomerSelectable: boolean;
    label: string;
  };
}

export function buildGiftTierOfferDrafts(raw: GiftTierCampaign, currencyCode: string): GiftTierOfferDraft[] {
  const campaign = giftTierCampaignSchema.parse(raw);
  const tiers = [...campaign.tiers].sort((a, b) => a.minimumSubtotalCents - b.minimumSubtotalCents);
  return tiers.map((tier, index) => {
    const nextTier = tiers[index + 1];
    const condition: GiftTierOfferDraft["condition"] = {
      thresholdCents: tier.minimumSubtotalCents,
      currencyCode,
      includeGiftValues: false,
    };
    if (campaign.stackingMode === "highest_tier_only" && nextTier) {
      condition.maxCents = nextTier.minimumSubtotalCents - 1;
    }
    return {
      internalName: `[Gift tiers:${campaign.campaignId}:${tier.id}] ${campaign.name}`,
      publicTitle: `${campaign.name} — ${tier.id}`,
      priority: 200 + index,
      condition,
      reward: {
        target: { scope: "cart", variantIds: tier.variantIds },
        quantity: tier.quantity,
        isAutoAdd: tier.variantIds.length === 1,
        isCustomerSelectable: tier.variantIds.length > 1,
        label: `${campaign.name} gift at ${(tier.minimumSubtotalCents / 100).toFixed(2)}`,
      },
    };
  });
}
