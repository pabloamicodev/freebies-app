import { describe, expect, it } from "vitest";
import {
  PRODUCT_COLLECTIONS_QUERY,
  PRODUCT_VARIANTS_QUERY,
  PRODUCTS_QUERY,
} from "./product-sync.server.js";

describe("catalog sync GraphQL queries", () => {
  it("keeps the product page query free of nested high-cardinality connections", () => {
    expect(PRODUCTS_QUERY).toContain("products(first: $first, after: $after)");
    expect(PRODUCTS_QUERY).not.toContain("variants(first:");
    expect(PRODUCTS_QUERY).not.toContain("collections(first:");
  });

  it("supports the null cursor required by the first relation page", () => {
    expect(PRODUCT_VARIANTS_QUERY).toContain("$after: String)");
    expect(PRODUCT_COLLECTIONS_QUERY).toContain("$after: String)");
    expect(PRODUCT_VARIANTS_QUERY).toContain("variants(first: 250, after: $after)");
    expect(PRODUCT_COLLECTIONS_QUERY).toContain("collections(first: 250, after: $after)");
  });
});
