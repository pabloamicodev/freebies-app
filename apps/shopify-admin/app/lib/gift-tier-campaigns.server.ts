import { and, eq, inArray } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offers } from "@promo/db";
import type { ShopContext } from "./shop-context.server.js";
import { buildGiftTierOfferDrafts, giftTierCampaignSchema, type GiftTierCampaign } from "./gift-tier-campaigns.js";
import { parseJsonRecord } from "./offer-validation.server.js";
import { normalizeOfferSubconditions } from "./gift-subconditions.js";

export type GiftTierCampaignResult =
  | { error: string }
  | { campaign: GiftTierCampaign; created: number; skipped: number };

export async function createGiftTierCampaignOffers(
  { db, shopId, currencyCode }: Pick<ShopContext, "db" | "shopId" | "currencyCode">,
  formData: FormData,
): Promise<GiftTierCampaignResult> {
  try {
    const campaign = giftTierCampaignSchema.parse(
      JSON.parse(String(formData.get("campaign") ?? "{}")),
    );
    const subconditionsResult = parseJsonRecord(formData, "subconditions");
    if (subconditionsResult.error) return { error: subconditionsResult.error };
    const normalizedSubconditions = normalizeOfferSubconditions(subconditionsResult.data!);
    if (!normalizedSubconditions.success) return { error: normalizedSubconditions.error };
    const drafts = buildGiftTierOfferDrafts(campaign, currencyCode);
    const existing = await db
      .select({ internalName: offers.internalName })
      .from(offers)
      .where(
        and(
          eq(offers.shopId, shopId),
          inArray(
            offers.internalName,
            drafts.map((draft) => draft.internalName),
          ),
        ),
      );
    const existingNames = new Set(existing.map((offer) => offer.internalName));
    const pending = drafts.filter((draft) => !existingNames.has(draft.internalName));

    for (const draft of pending)
      await db.transaction(async (tx) => {
        const [offer] = await tx
          .insert(offers)
          .values({
            shopId,
            type: "gift",
            status: "draft",
            internalName: draft.internalName,
            publicTitle: draft.publicTitle,
            description: `Generated ${campaign.stackingMode.replaceAll("_", " ")} gift tier.`,
            priority: draft.priority,
            createdBy: "gift-tier-builder",
            updatedBy: "gift-tier-builder",
          })
          .returning({ id: offers.id });
        if (!offer) throw new Error(`Could not create ${draft.internalName}.`);
        await tx.insert(offerConditions).values({
          shopId,
          offerId: offer.id,
          scope: "main",
          conditionType: "cart_value",
          operator: "gte",
          value: draft.condition,
          sortOrder: 0,
          isEnabled: true,
        });
        for (const [index, subcondition] of normalizedSubconditions.data.entries()) {
          await tx.insert(offerConditions).values({
            shopId,
            offerId: offer.id,
            scope: "sub",
            conditionType: subcondition.conditionType,
            operator: subcondition.operator,
            value: subcondition.value,
            sortOrder: index + 1,
            isEnabled: true,
          });
        }
        await tx.insert(offerRewards).values({
          shopId,
          offerId: offer.id,
          rewardType: "product_gift",
          discountType: "free",
          value: { amount: 100, currencyCode },
          target: draft.reward.target,
          quantity: draft.reward.quantity,
          isAutoAdd: draft.reward.isAutoAdd,
          isCustomerSelectable: draft.reward.isCustomerSelectable,
          trackMode: "variant",
          sortOrder: 0,
          label: draft.reward.label,
        });
        await tx.insert(offerCombinationPolicies).values({ shopId, offerId: offer.id });
      });
    return { campaign, created: pending.length, skipped: drafts.length - pending.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Gift tier campaign is invalid." };
  }
}
