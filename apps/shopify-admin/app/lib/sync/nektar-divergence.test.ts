import { describe, expect, it } from "vitest";
import { compileOfferConfig } from "./compile-config.js";

const FLAVORS = Array.from({ length: 6 }, (_, i) => `gid://shopify/ProductVariant/${1000 + i}`);

const offer = { id: "11111111-1111-4111-8111-111111111111", type: "gift", priority: 100, publicTitle: "t", internalName: "t" } as never;
const row = (o: Record<string, unknown>) => ({ scope: "main", isEnabled: true, sortOrder: 0, ...o }) as never;

describe("Nektar offers: wizard-saved shapes vs the old app's semantics", () => {
  const compileWith = (operator: string | undefined) =>
    compileOfferConfig(
      offer,
      [
        row({
          conditionType: "specific_product",
          ...(operator ? { operator } : {}),
          value: { minQtyPerProduct: 1, multiplyGifts: false, giftsMatchProducts: false, trackMode: "product", appliesTo: "specific_products", variantIds: FLAVORS },
        }),
      ],
      [],
      null,
      1,
    );

  it("keeps existing gte rows all-of: one requirement per flavor", () => {
    const compiled = compileWith("gte");
    expect(compiled.requirements).toHaveLength(6);
    expect(compiled.anyRequiredVariantIds).toEqual([]);
  });

  it("keeps rows with no operator all-of", () => {
    const compiled = compileWith(undefined);
    expect(compiled.requirements).toHaveLength(6);
    expect(compiled.anyRequiredVariantIds).toEqual([]);
  });

  // Old app (hpn-scripts-migration ambrosia preset): ANY of the 6 flavor anchors unlocks the gift.
  it("compiles an any row to six any-of variant ids and no all-of requirements", () => {
    const compiled = compileWith("any");
    expect(compiled.anyRequiredVariantIds).toEqual(FLAVORS);
    expect(compiled.requirements).toEqual([]);
  });

});
