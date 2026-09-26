import { describe, expect, it } from "vitest";
import {
  PRODUCT_COLLECTIONS_QUERY,
  PRODUCT_VARIANTS_QUERY,
  PRODUCTS_QUERY,
} from "./product-sync.server.js";

describe("catalog sync GraphQL queries", () => {
  it("fetches variants inline with the product page, but not collections", () => {
    expect(PRODUCTS_QUERY).toContain("products(first: $first, after: $after)");
    // Variants ride along in the same round trip as the product page now —
    // almost no product has more than the inline page size, so this avoids a
    // per-product follow-up call for the overwhelming majority of the catalog.
    expect(PRODUCTS_QUERY).toContain("variants(first: $variantsFirst)");
    expect(PRODUCTS_QUERY).not.toContain("collections(first:");
  });

  it("supports the null cursor required by the first relation page", () => {
    expect(PRODUCT_VARIANTS_QUERY).toContain("$after: String)");
    expect(PRODUCT_COLLECTIONS_QUERY).toContain("$after: String)");
    expect(PRODUCT_VARIANTS_QUERY).toContain("variants(first: 250, after: $after)");
    expect(PRODUCT_COLLECTIONS_QUERY).toContain("collections(first: 250, after: $after)");
  });
});
