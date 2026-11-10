import { describe, expect, it } from "vitest";
import { toggleProductSelection } from "./picker-selection.js";

describe("toggleProductSelection", () => {
  it("counts ticking a single-variant product row as a whole-product pick", () => {
    const on = toggleProductSelection(new Set(), new Set(), "gid://shopify/Product/1", ["gid://shopify/ProductVariant/10"], "variants", true);
    expect([...on.selected]).toEqual(["gid://shopify/ProductVariant/10"]);
    expect([...on.whole]).toEqual(["gid://shopify/Product/1"]);
    const off = toggleProductSelection(on.selected, on.whole, "gid://shopify/Product/1", ["gid://shopify/ProductVariant/10"], "variants", true);
    expect(off.selected.size).toBe(0);
    expect(off.whole.size).toBe(0);
  });

  it("toggles the product gid itself in products mode without marking whole products", () => {
    const on = toggleProductSelection(new Set(), new Set(), "gid://shopify/Product/1", [], "products", true);
    expect([...on.selected]).toEqual(["gid://shopify/Product/1"]);
    expect(on.whole.size).toBe(0);
  });
});
