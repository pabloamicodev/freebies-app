import { describe, expect, it } from "vitest";
import { buildGiftTierOfferDrafts, type GiftTierCampaign } from "./gift-tier-campaigns.js";

const campaign: GiftTierCampaign = {
  campaignId: "holiday-gifts", name: "Holiday gifts", stackingMode: "highest_tier_only",
  tiers: [
    { id: "tier-100", minimumSubtotalCents: 10000, variantIds: ["gid://shopify/ProductVariant/200"], quantity: 1 },
    { id: "tier-50", minimumSubtotalCents: 5000, variantIds: ["gid://shopify/ProductVariant/100", "gid://shopify/ProductVariant/101"], quantity: 1 },
  ],
};

describe("buildGiftTierOfferDrafts", () => {
  it("creates non-overlapping subtotal bands for highest-tier-only campaigns", () => {
    const drafts = buildGiftTierOfferDrafts(campaign, "USD");
    expect(drafts.map((draft) => draft.condition)).toEqual([
      { thresholdCents: 5000, maxCents: 9999, currencyCode: "USD", includeGiftValues: false },
      { thresholdCents: 10000, currencyCode: "USD", includeGiftValues: false },
    ]);
  });

  it("keeps every threshold open for cumulative campaigns", () => {
    const drafts = buildGiftTierOfferDrafts({ ...campaign, stackingMode: "cumulative" }, "USD");
    expect(drafts.every((draft) => draft.condition.maxCents === undefined)).toBe(true);
  });

  it("auto-adds a single variant and requests selection for multiple variants", () => {
    const drafts = buildGiftTierOfferDrafts(campaign, "USD");
    expect(drafts[0]?.reward).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true });
    expect(drafts[1]?.reward).toMatchObject({ isAutoAdd: true, isCustomerSelectable: false });
  });
});
