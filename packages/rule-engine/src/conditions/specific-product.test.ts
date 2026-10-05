import { describe, it, expect } from "vitest";
import { evaluateSpecificProduct } from "./specific-product.js";
import type { NormalizedCart } from "@promo/shared-types";

function makeCart(lines: Array<{ variantId: string; productId: string; quantity: number }>): NormalizedCart {
  return {
    token: "test-token",
    id: null,
    lines: lines.map((l, i) => ({
      key: `key-${i}`,
      variantId: l.variantId,
      productId: l.productId,
      quantity: l.quantity,
      priceCents: 1000,
      compareAtPriceCents: null,
      properties: {},
      requiresSellingPlan: false,
      sellingPlanId: null,
      productHandle: "test-product",
      productTitle: "Test Product",
      variantTitle: null,
      vendor: "Test Vendor",
      productType: "apparel",
      tags: [],
      collections: [],
      availableForSale: true,
      inventoryPolicy: "DENY",
      inventoryQuantity: 10,
    })),
    subtotalCents: lines.reduce((a, l) => a + l.quantity * 1000, 0),
    discountCodes: [],
    currencyCode: "USD",
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

describe("evaluateSpecificProduct with operator 'all' (default)", () => {
  it("fails unless every requirement is met", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 2 }]);
    const result = evaluateSpecificProduct(cart, {
      requirements: [
        { productId: "p1", variantId: "v1", trackMode: "variant", minQuantity: 1 },
        { productId: "p2", variantId: "v2", trackMode: "variant", minQuantity: 1 },
      ],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(false);
  });

  it("passes when every requirement is met", () => {
    const cart = makeCart([
      { variantId: "v1", productId: "p1", quantity: 1 },
      { variantId: "v2", productId: "p2", quantity: 1 },
    ]);
    const result = evaluateSpecificProduct(cart, {
      requirements: [
        { productId: "p1", variantId: "v1", trackMode: "variant", minQuantity: 1 },
        { productId: "p2", variantId: "v2", trackMode: "variant", minQuantity: 1 },
      ],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("evaluateSpecificProduct with operator 'any'", () => {
  const condition = {
    requirements: [
      { productId: "p1", variantId: "v1", trackMode: "variant" as const, minQuantity: 1 },
      { productId: "p2", variantId: "v2", trackMode: "variant" as const, minQuantity: 1 },
    ],
    multiplyByGroups: false,
  };

  it("fails when none of the trigger products/variants are present", () => {
    const cart = makeCart([{ variantId: "v3", productId: "p3", quantity: 5 }]);
    expect(evaluateSpecificProduct(cart, condition, "any").ok).toBe(false);
  });

  it("passes when only one of the trigger products/variants is present", () => {
    const cart = makeCart([{ variantId: "v2", productId: "p2", quantity: 1 }]);
    const result = evaluateSpecificProduct(cart, condition, "any");
    expect(result.ok).toBe(true);
  });

  it("does not require every requirement to pass, unlike operator 'all'", () => {
    const cart = makeCart([{ variantId: "v1", productId: "p1", quantity: 1 }]);
    expect(evaluateSpecificProduct(cart, condition, "all").ok).toBe(false);
    expect(evaluateSpecificProduct(cart, condition, "any").ok).toBe(true);
  });
});

describe("evaluateSpecificProduct variant vs product matching", () => {
  const cart = makeCart([{ variantId: "v1-mint", productId: "p1", quantity: 1 }]);

  it("fails when two variants are required but only one is present", () => {
    const result = evaluateSpecificProduct(cart, {
      requirements: [
        { productId: "p1", variantId: "v1-mint", trackMode: "variant", minQuantity: 1 },
        { productId: "p1", variantId: "v1-cacao", trackMode: "variant", minQuantity: 1 },
      ],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(false);
  });

  it("product mode passes with any variant of the product", () => {
    const result = evaluateSpecificProduct(cart, {
      requirements: [{ productId: "p1", trackMode: "product", minQuantity: 1 }],
      multiplyByGroups: false,
    });
    expect(result.ok).toBe(true);
  });

  it("variant mode does not pool across variants; product mode does", () => {
    const split = makeCart([
      { variantId: "va", productId: "p1", quantity: 1 },
      { variantId: "vb", productId: "p1", quantity: 1 },
    ]);
    expect(evaluateSpecificProduct(split, {
      requirements: [{ productId: "p1", variantId: "va", trackMode: "variant", minQuantity: 2 }],
      multiplyByGroups: false,
    }).ok).toBe(false);
    expect(evaluateSpecificProduct(split, {
      requirements: [{ productId: "p1", trackMode: "product", minQuantity: 2 }],
      multiplyByGroups: false,
    }).ok).toBe(true);
  });

  it("is not exclusive: unrelated products in the cart do not fail it", () => {
    const mixed = makeCart([
      { variantId: "v1-mint", productId: "p1", quantity: 1 },
      { variantId: "other", productId: "p9", quantity: 4 },
    ]);
    expect(evaluateSpecificProduct(mixed, {
      requirements: [{ productId: "p1", variantId: "v1-mint", trackMode: "variant", minQuantity: 1 }],
      multiplyByGroups: false,
    }).ok).toBe(true);
  });
});
