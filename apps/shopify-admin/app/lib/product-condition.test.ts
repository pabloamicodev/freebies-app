import { describe, expect, it } from "vitest";
import { buildProductConditionValue, packVariantHint, productConditionHelp, readMatchBy, requirementGids } from "./product-condition.js";

describe("product-condition", () => {
  it("defaults to variant and reads product mode", () => {
    expect(readMatchBy({ requirements: [{ variantId: "v", trackMode: "variant", minQuantity: 1 }] })).toBe("variant");
    expect(readMatchBy({})).toBe("variant");
    expect(readMatchBy({ requirements: [{ productId: "p", trackMode: "product", minQuantity: 1 }] })).toBe("product");
  });

  it("builds one requirement per deduplicated product", () => {
    const value = buildProductConditionValue("specific_product", "product", ["p1", "p1", "p2"], 2);
    expect(value).toEqual({
      requirements: [
        { productId: "p1", trackMode: "product", minQuantity: 2 },
        { productId: "p2", trackMode: "product", minQuantity: 2 },
      ],
      multiplyByGroups: false,
    });
    expect(requirementGids(value)).toEqual(["p1", "p2"]);
  });

  it("builds per-variant pack requirements", () => {
    expect(buildProductConditionValue("pack_of_products", "variant", ["v1", "v2"], 1)).toEqual({
      requirements: [
        { variantId: "v1", trackMode: "variant", quantityPerPack: 1 },
        { variantId: "v2", trackMode: "variant", quantityPerPack: 1 },
      ],
      multiplyByPacks: false,
    });
  });

  it("explains the selection with a concrete example and covers all-of / other products / rewards", () => {
    const items = [
      { productId: "p1", productTitle: "Planta®", variantTitle: "Mint" },
      { productId: "p1", productTitle: "Planta®", variantTitle: "Cacao" },
    ];
    const help = productConditionHelp({ type: "specific_product", matchBy: "variant", minQty: 1, items });
    expect(help.example).toBe("Example: with Planta® (Mint) and Planta® (Cacao) at min 1, the cart needs at least 1 Planta® (Mint) AND 1 Planta® (Cacao).");
    const text = help.lines.join(" ");
    expect(text).toMatch(/all-of/);
    expect(text).toMatch(/Other products can also be in the cart/);
    expect(text).toMatch(/Rewards/);
    expect(productConditionHelp({ type: "specific_product", matchBy: "product", minQty: 2, items: [{ productTitle: "Planta®" }] }).example)
      .toBe("Example: with Planta® at min 2, the cart needs at least 2 Planta® (any variant).");
  });

  it("hints when a pack has several variants of the same product", () => {
    const items = [
      { productId: "p1", productTitle: "Planta®", variantTitle: "Mint" },
      { productId: "p1", productTitle: "Planta®", variantTitle: "Cacao" },
    ];
    expect(packVariantHint(items)).toBe("You selected 2 variants of Planta®; all 2 are required. Switch to 'Any variant of the product' if any variant should count.");
    expect(packVariantHint(items.slice(0, 1))).toBeNull();
  });
});
