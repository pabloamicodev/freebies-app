import { describe, expect, it } from "vitest";
import { compactCompiledOffer, type CompiledOffer } from "./compile-config.js";
import { normalizeCompiledOffer } from "./compiled-offer-compare.js";

const variant = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("normalizeCompiledOffer", () => {
  it("treats compact numeric ids and GIDs as equal", () => {
    const gid = { requiredVariantIds: [variant(1), variant(2)], requirements: [{ variantId: variant(3), productId: "gid://shopify/Product/4" }] };
    const compact = { requiredVariantIds: ["1", "2"], requirements: [{ variantId: "3", productId: "4" }] };
    expect(normalizeCompiledOffer(compact)).toEqual(normalizeCompiledOffer(gid));
  });

  it("unpacks lists published as a comma-joined string", () => {
    const ids = Array.from({ length: 150 }, (_, i) => variant(i + 1));
    const packed = { anyRequiredVariantIds: ids.join(","), giftRewards: [{ targetVariantIds: ids.join(",") }] };
    const plain = { anyRequiredVariantIds: ids, giftRewards: [{ targetVariantIds: ids }] };
    expect(normalizeCompiledOffer(packed)).toEqual(normalizeCompiledOffer(plain));
  });

  it("still detects a real difference", () => {
    expect(normalizeCompiledOffer({ requiredVariantIds: ["1"] })).not.toEqual(
      normalizeCompiledOffer({ requiredVariantIds: [variant(2)] }),
    );
  });

  it("matches what the publisher emits for a packed list against the database copy", () => {
    const ids = Array.from({ length: 120 }, (_, i) => variant(i + 1));
    const source = { requiredVariantIds: ids, requirements: [], giftRewards: [], productRewards: [], orderRewards: [] } as unknown as CompiledOffer;
    const published = compactCompiledOffer(source);
    expect(typeof published["requiredVariantIds"]).toBe("string");
    expect(normalizeCompiledOffer(published)["requiredVariantIds"]).toEqual(
      normalizeCompiledOffer({ requiredVariantIds: ids })["requiredVariantIds"],
    );
  });
});
