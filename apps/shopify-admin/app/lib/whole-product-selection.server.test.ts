import { describe, expect, it } from "vitest";
import { compactCompiledOffer, compileOfferConfig } from "./sync/compile-config.js";
import { buildRewardRecord } from "./reward-record.server.js";
import { parseJsonStringArray } from "./offer-validation.server.js";
import { resolveSelection, selectionFromPick } from "./whole-product-selection.server.js";

const P = (n: number) => `gid://shopify/Product/${n}`;
const V = (product: number, n: number) => `gid://shopify/ProductVariant/${product * 100 + n}`;
const variantsOf = (product: number, count = 12) => Array.from({ length: count }, (_, n) => V(product, n));
const owners = (products: number[], count = 12) =>
  new Map(products.flatMap((product) => variantsOf(product, count).map((variant) => [variant, P(product)] as const)));

describe("selectionFromPick", () => {
  it("turns products ticked as a whole back into product ids and marks a pure product selection", () => {
    const picked = [...variantsOf(1), ...variantsOf(2)];
    expect(selectionFromPick(picked, [P(1), P(2)], owners([1, 2]))).toEqual({
      productIds: [P(1), P(2)],
      variantIds: [],
      selectionLevel: "product",
    });
  });

  it("keeps variants picked one by one as variants and leaves the marker off", () => {
    const picked = [...variantsOf(1), V(2, 3)];
    const result = selectionFromPick(picked, [P(1)], owners([1, 2]));
    expect(result).toEqual({ productIds: [P(1)], variantIds: [V(2, 3)] });
  });

  it("ignores a whole-product claim that owns no picked variant, and malformed claims", () => {
    expect(selectionFromPick([V(1, 0)], [P(9), "not-a-gid"], owners([1]))).toEqual({ productIds: [], variantIds: [V(1, 0)] });
  });

  it("without a claim the picked variants stay as they are, and picked product ids are kept", () => {
    expect(selectionFromPick([...variantsOf(1, 3), P(5)], [], owners([1], 3))).toEqual({
      productIds: [P(5)],
      variantIds: variantsOf(1, 3),
      selectionLevel: undefined,
    });
  });
});

describe("a whole-product pick through the reward writer", () => {
  const products = Array.from({ length: 40 }, (_, n) => n + 1);
  const picked = products.flatMap((product) => variantsOf(product));
  const db = {
    select: () => ({ from: () => ({ where: async () => [...owners(products)].map(([variantGid, productGid]) => ({ variantGid, productGid })) }) }),
  };

  async function compiledBytes(whole: number[]) {
    const form = new FormData();
    form.set("rewardType", "product_discount");
    form.set("discountType", "percentage");
    form.set("discountValue", "10");
    form.set("productScopeMode", "sitewide");
    form.set("productTargetType", "variants");
    form.set("variantGids", picked.join("\n"));
    form.set("wholeProductGids", whole.map(P).join("\n"));
    const built = await buildRewardRecord(form, db as never, "shop", "USD");
    if ("error" in built) throw new Error(built.error);
    const compiled = compileOfferConfig(
      { id: "11111111-1111-4111-8111-111111111111", type: "discount", priority: 1 } as never,
      [],
      [{ id: "22222222-2222-4222-8222-222222222222", ...built.data, sortOrder: 0 } as never],
      null,
      1,
    );
    return { compiled, bytes: new TextEncoder().encode(JSON.stringify(compactCompiledOffer(compiled))).byteLength };
  }

  it("ships product ids instead of 480 variant ids, still targeting the same products", async () => {
    const variants = await compiledBytes([]);
    const whole = await compiledBytes(products);
    expect(variants.compiled.productRewards[0]!.targetVariantIds).toHaveLength(480);
    expect(whole.compiled.productRewards[0]!.targetVariantIds).toEqual([]);
    expect(whole.compiled.productRewards[0]!.targetProductIds).toEqual(products.map(P));
    expect(whole.bytes).toBeLessThan(variants.bytes / 5);
  });
});

describe("an upsell whole-product pick", () => {
  const products = Array.from({ length: 40 }, (_, n) => n + 1);
  const picked = products.flatMap((product) => variantsOf(product));
  const db = {
    select: () => ({ from: () => ({ where: async () => [...owners(products)].map(([variantGid, productGid]) => ({ variantGid, productGid })) }) }),
  };

  async function compile(whole: number[]) {
    const selection = await resolveSelection(db as never, "shop", picked, whole.map(P));
    const target = {
      scopeMode: "sitewide",
      scope: "cart",
      productIds: selection.productIds,
      variantIds: selection.variantIds,
      ...(selection.selectionLevel ? { selectionLevel: selection.selectionLevel } : {}),
    };
    const compiled = compileOfferConfig(
      { id: "11111111-1111-4111-8111-111111111111", type: "upsell", priority: 1 } as never,
      [],
      [{ id: "22222222-2222-4222-8222-222222222222", rewardType: "upsell_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target, sortOrder: 0 } as never],
      null,
      1,
    );
    return { compiled, bytes: new TextEncoder().encode(JSON.stringify(compactCompiledOffer(compiled))).byteLength };
  }

  it("ships product ids and far fewer bytes than the expanded variants", async () => {
    const variants = await compile([]);
    const whole = await compile(products);
    expect(variants.compiled.productRewards[0]!.targetVariantIds).toHaveLength(480);
    expect(whole.compiled.productRewards[0]!.targetVariantIds).toEqual([]);
    expect(whole.compiled.productRewards[0]!.targetProductIds).toEqual(products.map(P));
    expect(whole.bytes).toBeLessThan(variants.bytes / 5);
  });
});

describe("parseJsonStringArray on the whole-product field", () => {
  it("reports malformed JSON instead of an empty list", () => {
    const form = new FormData();
    form.set("discountWholeProducts", "{nope");
    expect(parseJsonStringArray(form, "discountWholeProducts").error).toBe("discountWholeProducts contains invalid JSON.");
    form.set("discountWholeProducts", "[1]");
    expect(parseJsonStringArray(form, "discountWholeProducts").error).toBeTruthy();
  });
});
