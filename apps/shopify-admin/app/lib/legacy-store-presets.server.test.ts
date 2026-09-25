import { describe, expect, it } from "vitest";
import { getLegacyStorePreset, validateLegacyStorePreset } from "./legacy-store-presets.server.js";

const expectedOfferCounts = new Map([
  ["hpn-supplements.myshopify.com", 3],
  ["onesolsupps.myshopify.com", 1],
  ["ambrosia-nutraceuticals.myshopify.com", 11],
  ["gettrusupps.myshopify.com", 8],
]);

describe("legacy store presets", () => {
  it("keeps the expected migration inventory for every supported store", () => {
    for (const [shopDomain, expectedCount] of expectedOfferCounts) {
      expect(getLegacyStorePreset(shopDomain)?.offers).toHaveLength(expectedCount);
    }
  });

  it("validates every condition and reward against the current shared contracts", () => {
    for (const shopDomain of expectedOfferCounts.keys()) {
      const preset = getLegacyStorePreset(shopDomain);
      expect(preset).not.toBeNull();
      expect(() => validateLegacyStorePreset(preset!)).not.toThrow();
    }
  });

  it("matches domains case-insensitively and rejects unknown shops", () => {
    expect(getLegacyStorePreset("HPN-SUPPLEMENTS.MYSHOPIFY.COM")?.sourceName).toBe(
      "HPN Supplements",
    );
    expect(getLegacyStorePreset("unknown.myshopify.com")).toBeNull();
  });

  it("includes the quiz-bundle free-shipping rule from the legacy HPN inventory", () => {
    const preset = getLegacyStorePreset("gettrusupps.myshopify.com");
    expect(preset?.offers.some((offer) => offer.key === "quiz-bundle-free-shipping")).toBe(true);
  });

  it("preserves the verified active Ambrosia migration inventory", () => {
    const preset = getLegacyStorePreset("ambrosia-nutraceuticals.myshopify.com");
    expect(preset?.offers.map((offer) => offer.key)).toEqual([
      "nektar-glp1-shaker-gift",
      "landing-nektar-skin-v2",
      "cart-subtotal-free-gift-mtrcmr6l",
      "sitewide-free-shipping-mtt2zu2r",
      "landing-free-shipping-mtt5s7nx",
      "landing-kinetic-sk-otg-freegifts",
      "landing-atlas-sk-otg-freegifts",
      "landing-nektar-sk-otg-freegifts",
      "landing-planta-sk-otg-freegifts",
      "landing-scoped-product-mtvt54kq",
      "landing-nektar-sk-special-nfgc10kit",
    ]);

    const gift = preset?.offers.find((offer) => offer.key === "cart-subtotal-free-gift-mtrcmr6l");
    expect(gift?.conditions[0]?.value).toMatchObject({
      thresholdCents: 8500,
      includeGiftValues: false,
    });
    expect(gift?.rewards[0]).toMatchObject({
      quantity: 1,
      isAutoAdd: false,
      isCustomerSelectable: true,
    });
    expect(gift?.rewards[0]?.target.variantIds as string[]).toHaveLength(4);

    const combo = preset?.offers.find((offer) => offer.key === "landing-scoped-product-mtvt54kq");
    expect(combo?.rewards[0]?.target).toMatchObject({
      requiredLineAttributeValue: "planta-atlas-combo-sk",
      requiredAnchorMinQuantity: 2,
      requiresAnchorSubscription: false,
    });

    const sitewideShipping = preset?.offers.find(
      (offer) => offer.key === "sitewide-free-shipping-mtt2zu2r",
    );
    expect(sitewideShipping?.description).toContain("Disabled");
    expect(sitewideShipping?.rewards[0]?.value.tiers).toEqual([
      {
        minimumSubtotalCents: 5000,
        discountType: "percentage",
        discountValue: 50,
        appliesWhen: "has_subscription",
      },
      {
        minimumSubtotalCents: 8000,
        discountType: "percentage",
        discountValue: 100,
        appliesWhen: "has_subscription",
      },
      {
        minimumSubtotalCents: 9000,
        discountType: "percentage",
        discountValue: 50,
        appliesWhen: "one_time_only",
      },
    ]);
  });
});
