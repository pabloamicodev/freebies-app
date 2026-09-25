import { describe, expect, it } from "vitest";
import { getLegacyStorePreset } from "./legacy-store-presets.server.js";
import { mapAmbrosiaPresetToDev } from "../../../../scripts/seed-ambrosia-e2e.js";

const fixtures = {
  anchorProductId: "gid://shopify/Product/100",
  anchorVariantId: "gid://shopify/ProductVariant/101",
  frotherProductId: "gid://shopify/Product/200",
  otgProductId: "gid://shopify/Product/300",
  giftCardProductId: "gid://shopify/Product/400",
  thirdGiftProductId: "gid://shopify/Product/500",
  shirtVariantIds: [
    "gid://shopify/ProductVariant/601",
    "gid://shopify/ProductVariant/602",
    "gid://shopify/ProductVariant/603",
    "gid://shopify/ProductVariant/604",
  ],
  sellingPlanId: "gid://shopify/SellingPlan/700",
};

describe("Ambrosia E2E fixture mapping", () => {
  it("maps all eleven source rules without retaining production catalog ids", () => {
    const preset = getLegacyStorePreset("ambrosia-nutraceuticals.myshopify.com");
    expect(preset).not.toBeNull();
    const mapped = mapAmbrosiaPresetToDev(preset!, fixtures);

    expect(mapped).toHaveLength(11);
    expect(mapped.filter((offer) => offer.status === "active")).toHaveLength(9);
    expect(mapped.filter((offer) => offer.status === "draft").map((offer) => offer.key)).toEqual([
      "sitewide-free-shipping-mtt2zu2r",
      "landing-free-shipping-mtt5s7nx",
    ]);

    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("7533558595669");
    expect(serialized).not.toContain("42872167202901");
    expect(serialized).toContain(fixtures.anchorVariantId);
    for (const id of fixtures.shirtVariantIds) expect(serialized).toContain(id);
  });

  it("preserves landing sources, subscription guards, quantities, and the subtotal tier", () => {
    const preset = getLegacyStorePreset("ambrosia-nutraceuticals.myshopify.com")!;
    const mapped = mapAmbrosiaPresetToDev(preset, fixtures);

    const combo = mapped.find((offer) => offer.key === "landing-scoped-product-mtvt54kq");
    expect(combo?.rewards[0]?.target).toMatchObject({
      requiredLineAttributeValue: "planta-atlas-combo-sk",
      requiredAnchorVariantIds: [fixtures.anchorVariantId],
      requiredAnchorMinQuantity: 2,
      requiresAnchorSubscription: false,
    });

    const atlas = mapped.find((offer) => offer.key === "landing-atlas-sk-otg-freegifts");
    expect(atlas?.rewards[0]?.target).toMatchObject({
      requiredLineAttributeValue: "atlas-sk-otg",
      requiredAnchorVariantIds: [],
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: true,
    });

    const shirt = mapped.find((offer) => offer.key === "cart-subtotal-free-gift-mtrcmr6l");
    expect(shirt?.conditions[0]?.value).toMatchObject({
      thresholdCents: 8500,
      includeGiftValues: false,
    });
    expect(shirt?.rewards[0]).toMatchObject({
      quantity: 1,
      isAutoAdd: false,
      isCustomerSelectable: true,
      target: { variantIds: fixtures.shirtVariantIds },
    });
  });
});
