import { useActionData } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offers } from "@promo/db";
import { GiftTierCampaignBuilder } from "../components/GiftTierCampaignBuilder.js";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";
import { buildGiftTierOfferDrafts, giftTierCampaignSchema } from "../lib/gift-tier-campaigns.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

export async function action({ request }: ActionFunctionArgs) {
  const [{ db, shopId, currencyCode }, formData] = await Promise.all([getShopContext(request), request.formData()]);
  if (formData.get("intent") !== "create-campaign") return { error: "Unsupported action." };
  try {
    const campaign = giftTierCampaignSchema.parse(JSON.parse(String(formData.get("campaign") ?? "{}")));
    const drafts = buildGiftTierOfferDrafts(campaign, currencyCode);
    const existing = await db.select({ internalName: offers.internalName })
      .from(offers)
      .where(and(
        eq(offers.shopId, shopId),
        inArray(offers.internalName, drafts.map((draft) => draft.internalName)),
      ));
    const existingNames = new Set(existing.map((offer) => offer.internalName));
    const pending = drafts.filter((draft) => !existingNames.has(draft.internalName));

    for (const draft of pending) await db.transaction(async (tx) => {
      const [offer] = await tx.insert(offers).values({ shopId, type: "gift", status: "draft", internalName: draft.internalName, publicTitle: draft.publicTitle, description: `Generated ${campaign.stackingMode.replaceAll("_", " ")} gift tier.`, priority: draft.priority, createdBy: "gift-tier-builder", updatedBy: "gift-tier-builder" }).returning({ id: offers.id });
      if (!offer) throw new Error(`Could not create ${draft.internalName}.`);
      await tx.insert(offerConditions).values({ shopId, offerId: offer.id, scope: "main", conditionType: "cart_value", operator: "gte", value: draft.condition, sortOrder: 0, isEnabled: true });
      await tx.insert(offerRewards).values({ shopId, offerId: offer.id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode }, target: draft.reward.target, quantity: draft.reward.quantity, isAutoAdd: draft.reward.isAutoAdd, isCustomerSelectable: draft.reward.isCustomerSelectable, trackMode: "variant", sortOrder: 0, label: draft.reward.label });
      await tx.insert(offerCombinationPolicies).values({ shopId, offerId: offer.id });
    });
    return { success: `Created ${pending.length} draft tier offer(s); ${drafts.length - pending.length} already existed.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Gift tier campaign is invalid." };
  }
}

export default function GiftTiersPage() {
  const actionData = useActionData<typeof action>();
  return <div className="b-page"><PageHeader title="Gift tiers" subtitle="Build exact cumulative or highest-tier-only cart subtotal gifts without changing the storefront design." />{actionData && "success" in actionData && <div className="b-banner b-banner-green" role="status">{actionData.success}</div>}{actionData && "error" in actionData && <div className="b-banner b-banner-red" role="alert">{actionData.error}</div>}<GiftTierCampaignBuilder /></div>;
}
