import { describe, expect, it } from "vitest";
import { serializeFunctionConfig, type CompiledOffer, type CompiledProductReward } from "./compile-config.js";
import { buildPlanUnitSet, slotOffers } from "./plan-units.js";
import { planShards, SLOT_LIMITS } from "./shard-planner.js";

const P = (n: number) => `gid://shopify/Product/${70000000000 + n}`;
const V = (n: number) => `gid://shopify/ProductVariant/${40000000000 + n}`;
const range = (count: number, make: (n: number) => string) => Array.from({ length: count }, (_, n) => make(n));
const POLICY = { productDiscounts: true, orderDiscounts: true };
const limits = (maxSlots: number) => ({ ...SLOT_LIMITS, maxSlots });

function offer(id: string, overrides: Partial<CompiledOffer> = {}): CompiledOffer {
  return {
    id,
    version: 1,
    offerType: "discount",
    title: `Offer ${id}`,
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

const reward = (overrides: Partial<CompiledProductReward> = {}): CompiledProductReward => ({
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
});

const entries = (offers: CompiledOffer[]) => offers.map((compiled) => ({ offerId: compiled.id, offer: compiled }));
const slotValue = (offers: CompiledOffer[]) =>
  serializeFunctionConfig({ offers, shippingOffers: [], version: "1", compiledAt: "2026-01-01T00:00:00.000Z" });
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

describe("buildPlanUnitSet: oversize offers", () => {
  const heavy = offer("heavy", { productRewards: [reward({ targetProductIds: range(900, P) })] });

  it("leaves a fitting offer as one unit", () => {
    const { units, splits } = buildPlanUnitSet(entries([offer("small", { productRewards: [reward({ targetProductIds: [P(1)] })] })]), [], []);
    expect(units[0]!.splittable).toBeUndefined();
    expect(units[0]!.splitRefusal).toBeUndefined();
    expect(splits.size).toBe(0);
  });

  it("hangs parts keyed offerId#k on an oversize splittable offer, each one fitting a slot alone", () => {
    const { units, splits } = buildPlanUnitSet(entries([heavy]), [], []);
    const parts = units[0]!.splittable!;
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.map((part) => part.key)).toEqual(parts.map((_, index) => `heavy#${index}`));
    for (const part of parts) {
      expect(part.priority).toBe(5);
      expect(part.targetProductIds).not.toBeNull();
    }
    expect(splits.get("heavy")!.parts).toHaveLength(parts.length);
  });

  it("records why an oversize offer cannot be split", () => {
    const tiers = [{ minimumQuantity: 2, discountType: "percentage" as const, discountValue: 10 }];
    const { units } = buildPlanUnitSet(entries([offer("tiered", { productRewards: [reward({ targetProductIds: range(900, P), quantityTiers: tiers })] })]), [], []);
    expect(units[0]!.splittable).toBeUndefined();
    expect(units[0]!.splitRefusal).toBe("AGGREGATING_REWARD");
  });

  it("splits variant targets under a per-product cap through the catalog's product map", () => {
    const capped = offer("capped", { productRewards: [reward({ targetVariantIds: range(900, V), maxUnitsPerProduct: 1 })] });
    expect(buildPlanUnitSet(entries([capped]), [], []).units[0]!.splitRefusal).toBe("VARIANT_PRODUCT_UNKNOWN");
    const mapped = buildPlanUnitSet(entries([capped]), [], [], { productOfVariant: (id) => P(Number(id.slice(-4)) % 200) });
    expect(mapped.units[0]!.splittable!.length).toBeGreaterThan(1);
  });
});

describe("planShards with split parts", () => {
  const heavy = offer("heavy", { productRewards: [reward({ targetProductIds: range(900, P) })] });
  const small = offer("small", { priority: 1, productRewards: [reward({ id: "r2", targetProductIds: [P(1)] })] });

  it("places an oversize splittable offer across slots when shards are on", () => {
    const { units, splits } = buildPlanUnitSet(entries([small, heavy]), [], []);
    const plan = planShards(units, new Map(), limits(11), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots.length).toBeGreaterThanOrEqual(3);
    const placed = plan.slots.flatMap((slot) => slot.unitKeys);
    expect(placed).toContain("small");
    expect(placed.filter((key) => key.startsWith("heavy#")).length).toBe(units[1]!.splittable!.length);
    expect(placed).not.toContain("heavy");

    const covered: string[] = [];
    for (const slot of plan.slots) {
      const offers = slotOffers([small, heavy], slot.unitKeys, splits);
      expect(byteLength(slotValue(offers))).toBeLessThanOrEqual(SLOT_LIMITS.slotBytes);
      for (const published of offers.filter((entry) => entry.id === "heavy")) {
        expect(published.title).toBe("Offer heavy");
        covered.push(...published.productRewards[0]!.targetProductIds);
      }
    }
    expect([...covered].sort()).toEqual(range(900, P).sort());
    expect(new Set(covered).size).toBe(900);
  });

  it("merges parts that land in the same slot back into one offer", () => {
    const { units, splits } = buildPlanUnitSet(entries([heavy]), [], []);
    const keys = units[0]!.splittable!.map((part) => part.key);
    const [merged, ...rest] = slotOffers([heavy], keys, splits);
    expect(rest).toEqual([]);
    expect(merged).toEqual(heavy);
    const two = slotOffers([heavy], keys.slice(0, 2), splits);
    expect(two).toHaveLength(1);
    expect(two[0]!.productRewards[0]!.targetProductIds.length).toBeLessThan(900);
  });

  it("keeps the placement of parts stable on a re-plan and moves nothing", () => {
    const { units } = buildPlanUnitSet(entries([small, heavy]), [], []);
    const first = planShards(units, new Map(), limits(11), POLICY);
    const previous = new Map(first.slots.flatMap((slot) => slot.unitKeys.map((key) => [key, slot.index] as const)));
    const again = planShards(units, previous, limits(11), POLICY);
    expect(again.moves).toEqual([]);
    expect(again.slots.map((slot) => slot.unitKeys)).toEqual(first.slots.map((slot) => slot.unitKeys));
  });

  it("keeps today's cap in single-shard mode: the splittable offer is OFFER_TOO_LARGE", () => {
    const { units } = buildPlanUnitSet(entries([heavy]), [], []);
    const plan = planShards(units, new Map(), limits(1), POLICY);
    expect(plan.blocked?.code).toBe("OFFER_TOO_LARGE");
    expect(plan.blocked?.unitKeys).toEqual(["heavy"]);
  });

  it("blocks an unsplittable oversize offer with OFFER_TOO_LARGE and the reason it could not be split", () => {
    const tiers = [{ minimumQuantity: 2, discountType: "percentage" as const, discountValue: 10 }];
    const tiered = offer("tiered", { productRewards: [reward({ targetProductIds: range(900, P), quantityTiers: tiers })] });
    const { units } = buildPlanUnitSet(entries([tiered]), [], []);
    const plan = planShards(units, new Map(), limits(11), POLICY);
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", unitKeys: ["tiered"], reason: "bytes", splitRefusal: "AGGREGATING_REWARD" });
  });

  it("runs out of slots with AUTOMATIC_DISCOUNT_LIMIT when the parts need more than the budget", () => {
    const { units } = buildPlanUnitSet(entries([heavy]), [], []);
    const plan = planShards(units, new Map(), limits(2), POLICY);
    expect(plan.blocked?.code).toBe("AUTOMATIC_DISCOUNT_LIMIT");
  });
});
