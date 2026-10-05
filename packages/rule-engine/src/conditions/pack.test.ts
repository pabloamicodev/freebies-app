import { describe, it, expect } from "vitest";
import { evaluatePack } from "./pack.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{
  variantId: string; productId: string; priceCents: number; quantity: number;
}>): NormalizedCart {
  return {
    token: "t", id: null,
    lines: lines.map((l, i) => ({
      key: `k${i}`, variantId: l.variantId, productId: l.productId,
      quantity: l.quantity, priceCents: l.priceCents, compareAtPriceCents: null,
      properties: {}, requiresSellingPlan: false, sellingPlanId: null,
      productHandle: "p", productTitle: "P", variantTitle: null,
      vendor: "V", productType: "T", tags: [], collections: [],
      availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 10,
    })),
    subtotalCents: lines.reduce((a, l) => a + l.priceCents * l.quantity, 0),
    discountCodes: [], currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

describe("evaluatePack", () => {
  it("passes when all products present for one pack", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", priceCents: 1000, quantity: 1 },
      { variantId: "v2", productId: "p2", priceCents: 2000, quantity: 1 },
    ]);
    const result = evaluatePack(cart, {
      requirements: [
        { trackMode: "product", productId: "p1", quantityPerPack: 1 },
        { trackMode: "product", productId: "p2", quantityPerPack: 1 },
      ],
      multiplyByPacks: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.packCount).toBe(1);
  });

  it("counts multiple packs correctly", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", priceCents: 1000, quantity: 3 },
      { variantId: "v2", productId: "p2", priceCents: 2000, quantity: 3 },
    ]);
    const result = evaluatePack(cart, {
      requirements: [
        { trackMode: "product", productId: "p1", quantityPerPack: 1 },
        { trackMode: "product", productId: "p2", quantityPerPack: 1 },
      ],
      multiplyByPacks: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.packCount).toBe(3);
  });

  it("pack count limited by scarcest item", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", priceCents: 1000, quantity: 5 },
      { variantId: "v2", productId: "p2", priceCents: 2000, quantity: 2 },
    ]);
    const result = evaluatePack(cart, {
      requirements: [
        { trackMode: "product", productId: "p1", quantityPerPack: 1 },
        { trackMode: "product", productId: "p2", quantityPerPack: 1 },
      ],
      multiplyByPacks: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.packCount).toBe(2);
  });

  it("fails when required product missing", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 1 }]);
    const result = evaluatePack(cart, {
      requirements: [
        { trackMode: "product", productId: "p1", quantityPerPack: 1 },
        { trackMode: "product", productId: "p2-missing", quantityPerPack: 1 },
      ],
      multiplyByPacks: false,
    });
    expect(result.ok).toBe(false);
  });

  it("respects maxPacks cap", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", priceCents: 1000, quantity: 10 }]);
    const result = evaluatePack(cart, {
      requirements: [{ trackMode: "product", productId: "p1", quantityPerPack: 1 }],
      multiplyByPacks: true,
      maxPacks: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.packCount).toBe(3);
  });

  describe("variant vs product matching", () => {
    const cart = makeCart([
      { variantId: "v1-mint", productId: "p1", priceCents: 1000, quantity: 1 },
      { variantId: "v2", productId: "p2", priceCents: 1000, quantity: 1 },
    ]);

    it("fails when two variants are required but only one is present", () => {
      const result = evaluatePack(cart, {
        requirements: [
          { trackMode: "variant", variantId: "v1-mint", quantityPerPack: 1 },
          { trackMode: "variant", variantId: "v1-cacao", quantityPerPack: 1 },
        ],
        multiplyByPacks: false,
      });
      expect(result.ok).toBe(false);
    });

    it("product mode passes with any variant of the product", () => {
      const result = evaluatePack(cart, {
        requirements: [
          { trackMode: "product", productId: "p1", quantityPerPack: 1 },
          { trackMode: "product", productId: "p2", quantityPerPack: 1 },
        ],
        multiplyByPacks: false,
      });
      expect(result.ok).toBe(true);
    });

    it("variant mode does not pool quantity across variants; product mode does", () => {
      const split = makeCart([
        { variantId: "va", productId: "p1", priceCents: 1000, quantity: 1 },
        { variantId: "vb", productId: "p1", priceCents: 1000, quantity: 1 },
      ]);
      expect(evaluatePack(split, {
        requirements: [{ trackMode: "variant", variantId: "va", quantityPerPack: 2 }],
        multiplyByPacks: false,
      }).ok).toBe(false);
      const pooled = evaluatePack(split, {
        requirements: [{ trackMode: "product", productId: "p1", quantityPerPack: 2 }],
        multiplyByPacks: false,
      });
      expect(pooled.ok).toBe(true);
    });
  });
});
