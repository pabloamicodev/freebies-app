import { describe, expect, it } from "vitest";
import type { CompiledGiftReward, CompiledOffer, CompiledProductReward } from "./compile-config.js";
import { mergeOfferParts, splitOffer, splittableLists, type SplitResult } from "./offer-split.js";
import { unitBytes } from "./shard-planner.js";

const MAX = 9000;
const V = (n: number) => `gid://shopify/ProductVariant/${40000000000 + n}`;
const P = (n: number) => `gid://shopify/Product/${70000000000 + n}`;
const range = (count: number, make: (n: number) => string) => Array.from({ length: count }, (_, n) => make(n));

function offer(overrides: Partial<CompiledOffer> = {}): CompiledOffer {
  return {
    id: "offer-1",
    version: 1,
    offerType: "discount",
    title: "Spring sale",
    priority: 5,
    stopLowerPriority: false,
    requiredProductIds: [],
    requiredVariantIds: [],
    anyRequiredProductIds: [],
    anyRequiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "percentage",
    discountValue: 10,
    currencyCode: "USD",
    combinesWithOrderDiscounts: true,
    combinesWithShippingDiscounts: true,
    combinesWithProductDiscounts: true,
    requirements: [],
    giftRewards: [],
    productRewards: [],
    orderRewards: [],
    ...overrides,
  };
}

function productReward(overrides: Partial<CompiledProductReward> = {}): CompiledProductReward {
  return {
    id: "r1",
    targetProductIds: [],
    targetVariantIds: [],
    discountType: "percentage",
    discountValue: 20,
    subscriptionMode: "any",
    scopeMode: "sitewide",
    requiredAnchorVariantIds: [],
    requiredAnchorMinQuantity: 1,
    requiresAnchorSubscription: false,
    priceTiers: [],
    quantityTiers: [],
    selectionMode: "all",
    countRule: "all",
    discountPercentageOnGifts: 100,
    ...overrides,
  };
}

function giftReward(overrides: Partial<CompiledGiftReward> = {}): CompiledGiftReward {
  return { id: "g1", targetProductIds: [], targetVariantIds: [], discountType: "free", discountValue: 100, maxQuantity: 2, ...overrides };
}

function split(compiled: CompiledOffer, options = {}, max = MAX): Extract<SplitResult, { ok: true }> {
  const result = splitOffer(compiled, max, options);
  if (!result.ok) throw new Error(`expected a split, got ${result.reason}`);
  return result;
}

const refusal = (compiled: CompiledOffer, options = {}): string => {
  const result = splitOffer(compiled, MAX, options);
  return result.ok ? "split" : result.reason;
};

const sitewide = (productCount = 600, overrides: Partial<CompiledProductReward> = {}) =>
  offer({ productRewards: [productReward({ targetProductIds: range(productCount, P), ...overrides })] });

describe("splitOffer: product reward targets", () => {
  it("slices product ids into disjoint parts that cover the list, keep the offer identity and fit", () => {
    const compiled = sitewide();
    expect(unitBytes(compiled)).toBeGreaterThan(MAX);
    const result = split(compiled);
    expect(result.parts.length).toBeGreaterThanOrEqual(2);
    const slices = result.parts.map((part) => part.offer.productRewards[0]!.targetProductIds);
    expect(slices.flat().sort()).toEqual([...range(600, P)].sort());
    expect(new Set(slices.flat()).size).toBe(600);
    for (const part of result.parts) {
      expect(part.offer.id).toBe("offer-1");
      expect(part.offer.title).toBe("Spring sale");
      expect(unitBytes(part.offer)).toBeLessThanOrEqual(MAX);
    }
  });

  it("balances parts instead of filling all but the last", () => {
    const sizes = split(sitewide()).parts.map((part) => unitBytes(part.offer));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(600);
  });

  it("refuses a per-product cap over variants without a product map, and keeps a product's variants together with one", () => {
    const variants = range(600, V);
    const compiled = offer({ productRewards: [productReward({ targetVariantIds: variants, maxUnitsPerProduct: 1 })] });
    expect(refusal(compiled)).toBe("VARIANT_PRODUCT_UNKNOWN");
    const productOfVariant = (id: string) => P(Number(id.slice(-4)) % 150);
    const result = split(compiled, { productOfVariant });
    const owners = new Map<string, number>();
    for (const part of result.parts) {
      for (const id of part.offer.productRewards[0]!.targetVariantIds) {
        const product = productOfVariant(id);
        expect(owners.get(product) ?? part.index).toBe(part.index);
        owners.set(product, part.index);
      }
    }
    expect(owners.size).toBe(150);
  });

  it("splits variants freely under per-line and per-variant caps", () => {
    const compiled = offer({ productRewards: [productReward({ targetVariantIds: range(600, V), maxUnitsPerLine: 1, maxUnitsPerVariant: 2 })] });
    expect(split(compiled).parts.length).toBeGreaterThan(1);
  });

  it.each([
    ["quantity tiers", { quantityTiers: [{ minimumQuantity: 2, discountType: "percentage" as const, discountValue: 10 }] }, "AGGREGATING_REWARD"],
    ["price tiers", { priceTiers: [{ quantity: 2, targetPricePerUnit: 5 }] }, "AGGREGATING_REWARD"],
    ["a unit total", { maxUnitsTotal: 3 }, "AGGREGATING_REWARD"],
    ["cheapest selection", { selectionMode: "cheapest" as const }, "AGGREGATING_REWARD"],
    ["cheapest item free", { discountType: "cheapest_item_free" }, "AGGREGATING_REWARD"],
    ["a cart-wide unit cap on a sitewide reward", { maxQuantity: 3 }, "CART_WIDE_CAP"],
  ])("refuses %s", (_label, overrides, reason) => {
    expect(refusal(sitewide(600, overrides))).toBe(reason);
  });

  it("refuses a per-cart cap on a sitewide reward but allows it on a landing set (it only lowers the per-product limit)", () => {
    expect(refusal({ ...sitewide(), mpc: 2 })).toBe("CART_WIDE_CAP");
    const landing = offer({
      mpc: 2,
      productRewards: [productReward({ scopeMode: "landing", discountType: "free", targetProductIds: range(600, P), requiredLineAttributeValue: "x" })],
    });
    expect(split(landing).parts.length).toBeGreaterThan(1);
  });

  it("refuses a set-limited reward whose targets mix products and variants (the Function caps them differently)", () => {
    const compiled = offer({
      productRewards: [productReward({ scopeMode: "landing", discountType: "free", targetProductIds: range(300, P), targetVariantIds: range(300, V) })],
    });
    expect(refusal(compiled)).toBe("MIXED_TARGETS");
  });
});

describe("splitOffer: anchors", () => {
  const anchored = (overrides: Partial<CompiledProductReward> = {}, count = 600) =>
    offer({
      productRewards: [
        productReward({
          scopeMode: "landing",
          discountType: "free",
          requiredLineAttributeValue: "kinetic",
          targetProductIds: [P(1)],
          requiredAnchorVariantIds: range(count, V),
          ...overrides,
        }),
      ],
    });

  it("slices 600 landing anchors, leaving the target intact in every part", () => {
    const result = split(anchored());
    expect(result.listId).toBe("productRewards.0.requiredAnchorVariantIds");
    expect(result.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.parts.flatMap((part) => part.offer.productRewards[0]!.requiredAnchorVariantIds).sort()).toEqual(range(600, V).sort());
    for (const part of result.parts) expect(part.offer.productRewards[0]!.targetProductIds).toEqual([P(1)]);
  });

  it("refuses when more than one anchor unit is required (the units could sit in different slices)", () => {
    expect(refusal(anchored({ requiredAnchorMinQuantity: 2 }))).toBe("ANCHOR_MIN_QUANTITY");
  });

  it("refuses anchors of a reward that aggregates across lines", () => {
    expect(refusal(anchored({ quantityTiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 10 }] }))).toBe("AGGREGATING_REWARD");
  });

  it("refuses an anchor list on a non-landing reward", () => {
    expect(refusal(anchored({ scopeMode: "sitewide" }))).toBe("NOT_LANDING_ANCHOR");
  });
});

describe("splitOffer: anyRequiredVariantIds", () => {
  const triggered = (overrides: Partial<CompiledOffer> = {}) =>
    offer({ anyRequiredVariantIds: range(600, V), productRewards: [productReward({ targetProductIds: [P(1)] })], ...overrides });

  it("slices the any-of trigger list of a product-reward offer", () => {
    const result = split(triggered());
    expect(result.listId).toBe("anyRequired");
    expect(result.parts.flatMap((part) => part.offer.anyRequiredVariantIds).sort()).toEqual(range(600, V).sort());
  });

  it("slices the trigger list of a gift offer", () => {
    const compiled = triggered({ offerType: "gift", productRewards: [], giftRewards: [giftReward({ targetProductIds: [P(900)], targetVariantIds: [V(900)] })] });
    const productOfVariant = (id: string) => P(Number(id.slice(-4)) + 5000);
    expect(refusal(compiled)).toBe("VARIANT_PRODUCT_UNKNOWN");
    expect(split(compiled, { productOfVariant }).parts.length).toBeGreaterThan(1);
  });

  it("refuses when a gift variant is also a trigger (an untagged gift line reserves a unit only in the part that lists it)", () => {
    const compiled = triggered({ offerType: "gift", productRewards: [], giftRewards: [giftReward({ targetVariantIds: [V(5)] })] });
    expect(refusal(compiled)).toBe("GIFT_ANCHOR_OVERLAP");
  });

  it("refuses an offer with order rewards", () => {
    const compiled = triggered({ orderRewards: [{ id: "o", discountType: "percentage", discountValue: 5, subtotalTiers: [] }] });
    expect(refusal(compiled)).toBe("ORDER_REWARDS");
  });
});

describe("splitOffer: gift targets", () => {
  const gifts = (overrides: Partial<CompiledGiftReward> = {}, extra: Partial<CompiledOffer> = {}) =>
    offer({ offerType: "gift", giftRewards: [giftReward({ targetProductIds: range(600, P), ...overrides })], ...extra });

  it("slices by gift product and keeps the limit, the reward id and the mirrored offer-level lists in line", () => {
    const compiled = gifts({}, { giftProductIds: range(600, P), giftVariantIds: ["gid://shopify/ProductVariant/fallback"] });
    const result = split(compiled);
    const slices = result.parts.map((part) => part.offer.giftRewards[0]!);
    expect(slices.flatMap((reward) => reward.targetProductIds).sort()).toEqual(range(600, P).sort());
    for (const [index, reward] of slices.entries()) {
      expect(reward.maxQuantity).toBe(2);
      expect(reward.id).toBe("g1");
      expect(result.parts[index]!.offer.giftProductIds).toEqual(reward.targetProductIds);
      expect(result.parts[index]!.offer.giftVariantIds).toEqual(["gid://shopify/ProductVariant/fallback"]);
    }
  });

  it("keeps the variants of one gift product in one part", () => {
    const compiled = gifts({ targetVariantIds: [V(1)] });
    expect(refusal(compiled)).toBe("VARIANT_PRODUCT_UNKNOWN");
    const result = split(compiled, { productOfVariant: () => P(1) });
    const holder = result.parts.filter((part) => part.offer.giftRewards[0]!.targetVariantIds.includes(V(1)));
    expect(holder).toHaveLength(1);
    expect(holder[0]!.offer.giftRewards[0]!.targetProductIds).toContain(P(1));
  });

  it("does not refuse for the offer-level maxGiftQuantity: the Function never reads it, and every compiled gift offer carries it", () => {
    expect(split(gifts({}, { maxGiftQuantity: 2 })).parts.length).toBeGreaterThan(1);
  });

  it("refuses a picker and a customer-selectable reward", () => {
    expect(refusal(gifts({ selectable: true }))).toBe("GIFT_PICKER");
    expect(refusal(gifts({ selectionCount: 1 }))).toBe("GIFT_PICKER");
    expect(refusal(gifts({ targetVariantIds: [V(1), V(2)] }))).toBe("GIFT_PICKER");
  });
});

describe("splitOffer: a set of gift rewards", () => {
  // "Add all gifts": one reward per gift product, each product with a few variants (a picker per reward).
  const set = (count: number, extra: Partial<CompiledOffer> = {}, patch: (index: number) => Partial<CompiledGiftReward> = () => ({})) =>
    offer({
      offerType: "gift",
      maxGiftQuantity: count,
      giftProductIds: range(count, (n) => P(2000 + n)),
      giftVariantIds: range(count * 2, (n) => V(2000 + n)),
      giftRewards: Array.from({ length: count }, (_, n) => n).map((n) =>
        giftReward({
          id: `reward-${n}`,
          targetProductIds: [P(2000 + n)],
          targetVariantIds: [V(2000 + 2 * n), V(2001 + 2 * n)],
          selectable: true,
          ...patch(n),
        }),
      ),
      ...extra,
    });
  const owners = (variant: string) => P(2000 + Math.floor((Number(variant.slice(-4)) - 2000) / 2));

  it("splits the reward array into whole rewards, mirrors the offer-level lists and merges back", () => {
    const compiled = set(60);
    expect(unitBytes(compiled)).toBeGreaterThan(MAX);
    const result = split(compiled, { productOfVariant: owners });
    expect(result.listId).toBe("giftRewards");
    const ids = result.parts.flatMap((part) => part.offer.giftRewards.map((reward) => reward.id));
    expect(ids.sort()).toEqual(range(60, (n) => `reward-${n}`).sort());
    for (const part of result.parts) {
      const rewards = part.offer.giftRewards;
      expect(part.offer.giftProductIds).toEqual(rewards.flatMap((reward) => reward.targetProductIds));
      expect(part.offer.giftVariantIds).toEqual(rewards.flatMap((reward) => reward.targetVariantIds));
      expect(unitBytes(part.offer)).toBeLessThanOrEqual(MAX);
    }
    expect(mergeOfferParts(compiled, [...result.parts].reverse(), result.paths, result.rewardArray)).toEqual(compiled);
  });

  it("needs the product map for variant targets, and refuses without it", () => {
    expect(refusal(set(60))).toBe("VARIANT_PRODUCT_UNKNOWN");
  });

  it("refuses rewards that share a gift product or variant (the first matching reward wins on a line)", () => {
    expect(refusal(set(60, {}, (n) => (n === 1 ? { targetProductIds: [P(2000)] } : {})), { productOfVariant: owners })).toBe("GIFT_REWARDS_OVERLAP");
    expect(refusal(set(60, {}, (n) => (n === 1 ? { targetVariantIds: [V(2000), V(2003)] } : {})), { productOfVariant: owners })).toBe("GIFT_REWARDS_OVERLAP");
  });

  it("refuses a cap that spans rewards: selectionCount, or highest-tier mode with tiers", () => {
    expect(refusal(set(60, {}, () => ({ selectionCount: 1 })), { productOfVariant: owners })).toBe("GIFT_PICKER");
    expect(refusal(set(60, { tm: "h" }, () => ({ mcs: 5000 })), { productOfVariant: owners })).toBe("GIFT_TIER_HIGHEST");
  });

  it("allows cumulative tiers: each reward is unlocked on its own threshold", () => {
    expect(split(set(60), { productOfVariant: owners }).parts.length).toBeGreaterThan(1);
    expect(split(set(60, {}, (n) => ({ mcs: 1000 * (n + 1) })), { productOfVariant: owners }).parts.length).toBeGreaterThan(1);
  });
});

describe("splitOffer: page patterns", () => {
  const paged = (overrides: Partial<CompiledOffer> = {}, matchMode: "starts_with" | "page_type" = "starts_with", patterns = range(500, (n) => `/collections/launch-${n}`)) =>
    offer({
      productRewards: [productReward({ targetProductIds: [P(1)] })],
      pageUrlConditions: [{ patterns, matchMode, caseSensitive: false }],
      ...overrides,
    });

  it("slices the patterns of a condition (an OR) and leaves the other fields alone", () => {
    const result = split(paged());
    expect(result.parts.flatMap((part) => part.offer.pageUrlConditions![0]!.patterns).sort()).toEqual(range(500, (n) => `/collections/launch-${n}`).sort());
    for (const part of result.parts) expect(part.offer.pageUrlConditions![0]!.matchMode).toBe("starts_with");
  });

  it("repeats page_type exclusions in every part so they keep winning over the listed pages", () => {
    const patterns = [...range(500, (n) => `/pages/landing-${n}`), "!/pages/landing-7"];
    const result = split(paged({}, "page_type", patterns));
    for (const part of result.parts) expect(part.offer.pageUrlConditions![0]!.patterns).toContain("!/pages/landing-7");
  });

  it("refuses when every non-matching line makes the offer fail (an AND over lines)", () => {
    expect(refusal(paged({ rejectUnmatchedLines: true }))).toBe("REJECT_UNMATCHED_LINES");
  });

  it("refuses restricted lines for a reward that aggregates", () => {
    const compiled = paged({
      restrictToMatchedLines: true,
      productRewards: [productReward({ targetProductIds: [P(1)], quantityTiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 10 }] })],
    });
    expect(refusal(compiled)).toBe("AGGREGATING_REWARD");
  });
});

describe("splitOffer: shapes outside the table", () => {
  it("refuses required customer tags: the Function needs ALL of them, so a slice would widen the audience", () => {
    const compiled = offer({ requiredCustomerTags: range(120, (n) => `vip-${n}`), productRewards: [productReward({ targetProductIds: [P(1)] })] });
    expect(refusal(compiled)).toBe("REQUIRED_TAGS_ALL_OF");
  });

  it("refuses excluded tags, all-of requirements, required ids and excluded products", () => {
    const base = { productRewards: [productReward({ targetProductIds: [P(1)] })] };
    expect(refusal(offer({ ...base, excludedCustomerTags: range(120, (n) => `block-${n}`) }))).toBe("EXCLUDED_TAGS");
    expect(
      refusal(offer({ ...base, requirements: range(300, (n) => V(n)).map((variantId) => ({ variantId, trackMode: "variant" as const, minQuantity: 1 })) })),
    ).toBe("ALL_OF_CONDITION");
    expect(refusal(offer({ ...base, requiredVariantIds: range(600, V) }))).toBe("REQUIRED_IDS");
    expect(refusal(offer({ ...base, excludedProductIds: range(600, P) }))).toBe("EXCLUDED_PRODUCTS");
  });

  it("refuses stop-lower-priority offers, quiz bundles, anchor-consuming offers and offers without rewards", () => {
    expect(refusal({ ...sitewide(), stopLowerPriority: true })).toBe("STOP_LOWER_PRIORITY");
    expect(refusal(sitewide(600, { scopeMode: "quiz_bundle" }))).toBe("QUIZ_BUNDLE");
    expect(refusal({ ...sitewide(), canStackWithGiftOffers: false })).toBe("ANCHOR_CONSUMPTION");
    expect(refusal(offer({ anyRequiredVariantIds: range(600, V) }))).toBe("NO_REWARD_SHAPE");
  });

  it("reports NO_SPLITTABLE_LIST when no list is present and STILL_TOO_LARGE when one id group cannot fit", () => {
    expect(refusal(offer({ productRewards: [productReward()] }))).toBe("NO_SPLITTABLE_LIST");
    const result = splitOffer(sitewide(600), 100);
    expect(!result.ok && result.reason).toBe("STILL_TOO_LARGE");
  });

  it("refuses to split on the largest list when that list is the unsplittable one", () => {
    const compiled = offer({ requiredVariantIds: range(800, V), productRewards: [productReward({ targetProductIds: range(100, P) })] });
    expect(refusal(compiled)).toBe("REQUIRED_IDS");
  });
});

describe("splittableLists", () => {
  it("lists each list with its verdict and reason", () => {
    const compiled = offer({
      requiredCustomerTags: ["a"],
      anyRequiredVariantIds: range(10, V),
      productRewards: [productReward({ targetProductIds: range(10, P), maxQuantity: 1 })],
    });
    const lists = splittableLists(compiled);
    expect(lists.find((list) => list.id === "anyRequired")).toMatchObject({ splittable: true, size: expect.any(Number) });
    expect(lists.find((list) => list.id === "productRewards.0.targets")).toMatchObject({ splittable: false, reason: "CART_WIDE_CAP" });
    expect(lists.find((list) => list.id === "requiredCustomerTags")).toMatchObject({ splittable: false, reason: "REQUIRED_TAGS_ALL_OF" });
  });

  it("marks every list with the offer-level reason when the offer cannot split at all", () => {
    const lists = splittableLists({ ...sitewide(10), stopLowerPriority: true });
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((list) => !list.splittable && list.reason === "STOP_LOWER_PRIORITY")).toBe(true);
  });
});

describe("mergeOfferParts", () => {
  it("gives back the base lists when every part is merged, whatever the order", () => {
    const compiled = sitewide();
    const result = split(compiled);
    const merged = mergeOfferParts(compiled, [...result.parts].reverse(), result.paths);
    expect(merged).toEqual(compiled);
  });

  it("merges a subset in the base order", () => {
    const compiled = sitewide();
    const result = split(compiled);
    const merged = mergeOfferParts(compiled, [result.parts[2]!, result.parts[0]!], result.paths);
    const expected = new Set([...result.parts[0]!.offer.productRewards[0]!.targetProductIds, ...result.parts[2]!.offer.productRewards[0]!.targetProductIds]);
    expect(merged.productRewards[0]!.targetProductIds).toEqual(compiled.productRewards[0]!.targetProductIds.filter((id) => expected.has(id)));
  });

  it("merges mirrored gift lists and page exclusions back without duplicates", () => {
    const compiled = offer({
      offerType: "gift",
      giftProductIds: range(600, P),
      giftRewards: [giftReward({ targetProductIds: range(600, P) })],
    });
    const result = split(compiled);
    expect(mergeOfferParts(compiled, result.parts, result.paths)).toEqual(compiled);
  });
});
