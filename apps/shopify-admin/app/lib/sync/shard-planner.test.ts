import { describe, expect, it } from "vitest";
import { serializeFunctionConfig, type CompiledOffer } from "./compile-config.js";
import {
  SLOT_LIMITS,
  envelopeBytes,
  planShards,
  unitBytes,
  andPolicies,
  OPEN_POLICY,
  type CombinationPolicy,
  type PlanUnit,
  type PlannerLimits,
  type ShardPlan,
} from "./shard-planner.js";

const limits = (maxSlots = 11, extra: Partial<PlannerLimits> = {}): PlannerLimits => ({ ...SLOT_LIMITS, maxSlots, ...extra });
const POLICY = "uniform" as const;
const NONE = new Map<string, number>();

const unit = (key: string, bytes = 1900, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  key,
  bytes,
  cartAttributeKeys: [],
  customerTags: [],
  priority: 10,
  hasOrderRewards: false,
  stopLowerPriority: false,
  targetProductIds: [`p-${key}`],
  multiLineFixed: false,
  ...extra,
});

const named = (count: number, bytes = 1900, extra: Partial<PlanUnit> = {}) =>
  Array.from({ length: count }, (_, i) => unit(`u${String(i).padStart(3, "0")}`, bytes, extra));

const assignment = (plan: ShardPlan) =>
  new Map(plan.slots.flatMap((slot) => slot.unitKeys.map((key) => [key, slot.index] as const)));
const slotOf = (plan: ShardPlan, key: string) => assignment(plan).get(key);
const placedKeys = (plan: ShardPlan) => plan.slots.flatMap((slot) => slot.unitKeys).sort();

const shuffled = <T>(items: T[], seed: number): T[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const compiledOffer = (id: string, extra: Partial<CompiledOffer> = {}): CompiledOffer => ({
  id,
  version: 1,
  offerType: "gift",
  priority: 1,
  stopLowerPriority: false,
  requiredProductIds: [],
  requiredVariantIds: [],
  anyRequiredProductIds: [],
  anyRequiredVariantIds: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
  excludedProductIds: [],
  giftVariantIds: [],
  giftProductIds: [],
  discountType: "free",
  discountValue: 100,
  currencyCode: "USD",
  combinesWithOrderDiscounts: true,
  combinesWithShippingDiscounts: true,
  combinesWithProductDiscounts: true,
  requirements: [],
  giftRewards: [],
  productRewards: [],
  orderRewards: [],
  ...extra,
});

describe("byte accounting", () => {
  it("slot bytes equal serializeFunctionConfig exactly", () => {
    const offers = [compiledOffer("a", { title: "A" }), compiledOffer("b", { mpc: 2 }), compiledOffer("c")];
    const config = serializeFunctionConfig({
      offers,
      shippingOffers: [],
      version: "1",
      compiledAt: "1970-01-01T00:00:00.000Z",
      c1: "alpha",
      customerTags: ["vip", "wholesale"],
    });
    const expected = envelopeBytes(["alpha"], ["vip", "wholesale"]) + offers.reduce((s, o) => s + unitBytes(o), 0) - 1;
    expect(expected).toBe(new TextEncoder().encode(config).byteLength);
  });

  it("envelope includes l1/l2 when present", () => {
    const config = serializeFunctionConfig({
      offers: [],
      shippingOffers: [],
      version: "1",
      compiledAt: "1970-01-01T00:00:00.000Z",
      l1: "line-a",
      l2: "line-b",
    });
    expect(envelopeBytes([], [], { l1: "line-a", l2: "line-b" })).toBe(new TextEncoder().encode(config).byteLength);
    expect(envelopeBytes([], [], { l1: "line-a" })).toBeLessThan(envelopeBytes([], [], { l1: "line-a", l2: "line-b" }));
  });

  it("planned slot bytes match the formula", () => {
    const plan = planShards([unit("a", 700, { cartAttributeKeys: ["k"] }), unit("b", 900, { customerTags: ["t"] })], NONE, limits(), POLICY);
    expect(plan.slots[0]!.bytes).toBe(envelopeBytes(["k"], ["t"]) + 700 + 900 - 1);
  });
});

describe("single node parity", () => {
  it("everything fits: exactly one slot holding every unit in priority order", () => {
    const units = [unit("b", 1000, { priority: 2 }), unit("a", 1000, { priority: 5 }), unit("c", 1000, { priority: 1 })];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]!.index).toBe(0);
    expect(plan.slots[0]!.unitKeys).toEqual(["c", "b", "a"]);
    expect(plan.moves).toEqual([]);
    expect(plan.blocked).toBeUndefined();
  });

  it("fills slot 0 up to the hard cap (no 85% target) while nothing lives elsewhere", () => {
    const plan = planShards([unit("a", 4500), unit("b", 4600)], NONE, limits(), POLICY);
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]!.bytes).toBeLessThanOrEqual(9500);
  });

  it("no units still yields slot 0", () => {
    const plan = planShards([], NONE, limits(), POLICY);
    expect(plan.slots).toEqual([expect.objectContaining({ index: 0, unitKeys: [] })]);
  });
});

describe("pinning to slot 0", () => {
  it("C1: order-reward units go to slot 0 even when they were elsewhere", () => {
    const units = [...named(8), unit("order", 1500, { hasOrderRewards: true, priority: 1 })];
    const plan = planShards(units, new Map([["order", 2]]), limits(), POLICY);
    expect(slotOf(plan, "order")).toBe(0);
    expect(plan.moves).toContainEqual({ unitKey: "order", from: 2, to: 0 });
  });

  it("C2: a stop offer and every lower-priority unit share slot 0", () => {
    const units = [
      unit("stop", 1200, { priority: 5, stopLowerPriority: true }),
      unit("tail1", 1200, { priority: 6 }),
      unit("tail2", 1200, { priority: 9 }),
      ...named(6, 1900, { priority: 1 }),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    for (const key of ["stop", "tail1", "tail2"]) expect(slotOf(plan, key)).toBe(0);
    expect(plan.slots.length).toBeGreaterThan(1);
  });

  it("C2: the tail starts at the lowest priority among several stop offers", () => {
    const units = [
      unit("stopA", 800, { priority: 8, stopLowerPriority: true }),
      unit("stopB", 800, { priority: 3, stopLowerPriority: true }),
      unit("mid", 800, { priority: 5 }),
      unit("head", 800, { priority: 2 }),
      ...named(7, 1900, { priority: 1 }),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    for (const key of ["stopA", "stopB", "mid"]) expect(slotOf(plan, key)).toBe(0);
  });

  it("C5: multi-line fixed units colocate with intersecting targets only", () => {
    const units = [
      unit("quiz", 1500, { multiLineFixed: true, targetProductIds: ["p1", "p2"], priority: 1 }),
      unit("hit", 1500, { targetProductIds: ["p2"], priority: 2 }),
      unit("miss1", 1900, { targetProductIds: ["p9"] }),
      unit("miss2", 1900, { targetProductIds: ["p8"] }),
      unit("miss3", 1900, { targetProductIds: ["p7"] }),
      unit("miss4", 1900, { targetProductIds: ["p6"] }),
      unit("miss5", 1900, { targetProductIds: ["p5"] }),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(slotOf(plan, "quiz")).toBe(slotOf(plan, "hit"));
    expect(plan.slots.length).toBeGreaterThan(1);
  });

  it("C5: a sitewide multi-line unit intersects everything, so it pulls the whole group together", () => {
    const units = [
      unit("quiz", 1500, { multiLineFixed: true, targetProductIds: ["p1"] }),
      unit("site", 1500, { multiLineFixed: true, targetProductIds: null }),
      unit("other", 1500, { targetProductIds: ["p5"] }),
      ...named(4),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(slotOf(plan, "quiz")).toBe(slotOf(plan, "site"));
    expect(slotOf(plan, "quiz")).toBe(slotOf(plan, "other"));
  });

  it("C5 group that touches the slot-0 group joins slot 0", () => {
    const units = [
      unit("order", 1000, { hasOrderRewards: true, targetProductIds: ["p1"] }),
      unit("quiz", 1000, { multiLineFixed: true, targetProductIds: ["p1"] }),
      ...named(7),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(slotOf(plan, "quiz")).toBe(0);
  });
});

describe("slot limits", () => {
  it("keeps at most 3 cart attribute keys per slot", () => {
    const units = ["a", "b", "c", "d", "e", "f"].map((k) => unit(`u-${k}`, 300, { cartAttributeKeys: [k] }));
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.slots.length).toBeGreaterThan(1);
    for (const slot of plan.slots) expect(slot.keys.length).toBeLessThanOrEqual(3);
    expect(placedKeys(plan)).toHaveLength(6);
  });

  it("keeps at most 100 customer tags per slot", () => {
    const tags = (from: number) => Array.from({ length: 60 }, (_, i) => `tag-${from + i}`);
    const units = [0, 1, 2].map((i) => unit(`t${i}`, 300, { customerTags: tags(i * 60) }));
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.slots.length).toBeGreaterThan(1);
    for (const slot of plan.slots) expect(slot.tags.length).toBeLessThanOrEqual(100);
  });

  it("shared tags count once", () => {
    const tags = Array.from({ length: 90 }, (_, i) => `tag-${i}`);
    const plan = planShards([unit("a", 300, { customerTags: tags }), unit("b", 300, { customerTags: tags })], NONE, limits(), POLICY);
    expect(plan.slots).toHaveLength(1);
  });

  it("a unit with more than 3 keys or 100 tags is too large", () => {
    const plan = planShards(
      [unit("keys", 300, { cartAttributeKeys: ["a", "b", "c", "d"] }), unit("tags", 300, { customerTags: Array.from({ length: 101 }, (_, i) => `t${i}`) }), unit("ok", 300)],
      NONE,
      limits(),
      POLICY,
    );
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", unitKeys: ["keys", "tags"], reason: "keys" });
    expect(plan.blocked!.numbers).toMatchObject({ keys: 4, maxKeys: 3, maxTags: 100, slotBytes: 9500 });
  });

  it("reports the tag overflow of a single unit with its numbers", () => {
    const tags = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const plan = planShards([unit("tags", 300, { customerTags: tags })], NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", unitKeys: ["tags"], reason: "tags" });
    expect(plan.blocked!.numbers).toMatchObject({ tags: 101, maxTags: 100 });
  });

  it("a C5 group over the hard cap is blocked as GROUP_TOO_LARGE and no slot is emitted", () => {
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const units = [
      unit("quiz", 1500, { multiLineFixed: true, targetProductIds: ids }),
      ...ids.map((id) => unit(`m-${id}`, 2000, { targetProductIds: [id] })),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "GROUP_TOO_LARGE", reason: "bytes" });
    expect(plan.blocked!.unitKeys).toEqual(["m-p1", "m-p2", "m-p3", "m-p4", "m-p5", "quiz"]);
    expect(plan.blocked!.numbers["bytes"]).toBeGreaterThan(9500);
    expect(plan.slots).toEqual([]);
  });

  it("a C5 group with more than 3 cart attribute keys is blocked with reason keys", () => {
    const units = [
      unit("quiz", 500, { multiLineFixed: true, targetProductIds: ["p1"] }),
      ...["a", "b", "c", "d"].map((k) => unit(`m-${k}`, 500, { targetProductIds: ["p1"], cartAttributeKeys: [k] })),
    ];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "GROUP_TOO_LARGE", reason: "keys" });
  });
});

describe("determinism and stickiness", () => {
  const mixed = () => [
    ...named(30, 1700).map((u, i) => ({ ...u, bytes: 900 + ((i * 397) % 1500), priority: 1 + (i % 7) })),
    unit("order", 1500, { hasOrderRewards: true, priority: 3 }),
    unit("stop", 900, { stopLowerPriority: true, priority: 6 }),
  ];

  it("is independent of input order", () => {
    const base = planShards(mixed(), NONE, limits(), POLICY);
    for (const seed of [1, 2, 3, 4]) {
      expect(planShards(shuffled(mixed(), seed), NONE, limits(), POLICY)).toEqual(base);
    }
    const prev = assignment(base);
    const again = planShards(mixed(), prev, limits(), POLICY);
    for (const seed of [5, 6]) {
      expect(planShards(shuffled(mixed(), seed), prev, limits(), POLICY)).toEqual(again);
    }
  });

  it("re-planning an unchanged set moves nothing", () => {
    const first = planShards(mixed(), NONE, limits(), POLICY);
    const second = planShards(mixed(), assignment(first), limits(), POLICY);
    expect(second.moves).toEqual([]);
    expect(second.slots).toEqual(first.slots);
  });

  it("editing one unit's bytes moves no other unit", () => {
    const first = planShards(mixed(), NONE, limits(), POLICY);
    const edited = mixed().map((u) => (u.key === "u010" ? { ...u, bytes: u.bytes + 120 } : u));
    const second = planShards(edited, assignment(first), limits(), POLICY);
    expect(second.moves).toEqual([]);
  });

  it("adding one unit moves no other unit", () => {
    const first = planShards(mixed(), NONE, limits(), POLICY);
    const second = planShards([...mixed(), unit("zz-new", 1100, { priority: 4 })], assignment(first), limits(), POLICY);
    expect(second.moves).toEqual([]);
    expect(placedKeys(second)).toContain("zz-new");
  });

  it("removing a unit moves no other unit", () => {
    const first = planShards(mixed(), NONE, limits(), POLICY);
    const second = planShards(mixed().filter((u) => u.key !== "u005"), assignment(first), limits(), POLICY);
    expect(second.moves).toEqual([]);
  });

  it("evicts the largest unit of an overflowing slot first and nothing else", () => {
    const filler = unit("slot0", 8000, { hasOrderRewards: true, priority: 1 });
    const prev = new Map([["big", 1], ["mid", 1], ["small", 1]]);
    const units = [filler, unit("big", 4000), unit("mid", 3000), unit("small", 2600)];
    const plan = planShards(units, prev, limits(), POLICY);
    expect(plan.moves).toEqual([{ unitKey: "big", from: 1, to: 2 }]);
    expect(slotOf(plan, "mid")).toBe(1);
    expect(slotOf(plan, "small")).toBe(1);
  });
});

describe("compaction", () => {
  it("frees at most one slot per run", () => {
    const units = Array.from({ length: 5 }, (_, i) => unit(`s${i}`, 500, { targetProductIds: [`p${i}`] }));
    const prev = new Map(units.map((u, i) => [u.key, i] as const));
    const plan = planShards(units, prev, limits(), POLICY);
    expect(plan.slots).toHaveLength(4);
    expect(plan.moves).toHaveLength(1);
  });

  it("does not compact when slots are close to the byte need", () => {
    const units = Array.from({ length: 3 }, (_, i) => unit(`s${i}`, 6000, { targetProductIds: [`p${i}`] }));
    const prev = new Map(units.map((u, i) => [u.key, i] as const));
    const plan = planShards(units, prev, limits(), POLICY);
    expect(plan.slots).toHaveLength(3);
    expect(plan.moves).toEqual([]);
  });
});

describe("budget and blocks", () => {
  it("blocks with AUTOMATIC_DISCOUNT_LIMIT when more slots are needed than allowed", () => {
    const plan = planShards(named(5, 8000), NONE, limits(3), POLICY);
    expect(plan.blocked).toMatchObject({ code: "AUTOMATIC_DISCOUNT_LIMIT", numbers: { needed: 5, allowed: 3 } });
    expect(plan.blocked!.unitKeys.length).toBeGreaterThan(0);
  });

  it("falls back to the hard cap before asking for a slot beyond the budget", () => {
    const units = [unit("a", 8300), unit("b", 8300), unit("c", 600)];
    const plan = planShards(units, NONE, limits(2), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots).toHaveLength(2);
  });

  it("repacks units whose previous slot no longer exists within the new budget", () => {
    const plan = planShards([unit("a", 1000), unit("b", 1000)], new Map([["a", 5], ["b", 0]]), limits(3), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(slotOf(plan, "a")).toBeLessThan(3);
  });

  it("SLOT0_GROUP_TOO_LARGE names the stop offer when its tail cannot share slot 0", () => {
    const units = [unit("stop", 3000, { stopLowerPriority: true, priority: 1 }), unit("t1", 4000, { priority: 2 }), unit("t2", 4000, { priority: 3 })];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "SLOT0_GROUP_TOO_LARGE", unitKeys: ["stop"] });
  });

  it("SLOT0_GROUP_TOO_LARGE for order offers that do not fit together", () => {
    const units = [unit("o1", 5000, { hasOrderRewards: true }), unit("o2", 5000, { hasOrderRewards: true })];
    const plan = planShards(units, NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "SLOT0_GROUP_TOO_LARGE", unitKeys: ["o1", "o2"] });
  });
});

describe("single-shard mode", () => {
  const nonCombining = { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true };

  it("C4 fails: everything goes to slot 0 and moves back from other slots", () => {
    const plan = planShards([unit("a", 1000, { domain: nonCombining }), unit("b", 1000)], new Map([["b", 2]]), limits());
    expect(plan.slots).toHaveLength(1);
    expect(plan.moves).toEqual([{ unitKey: "b", from: 2, to: 0 }]);
  });

  it("C4 fails and slot 0 overflows: SLOT_FULL names the units that do not fit", () => {
    const plan = planShards(named(6, 2000, { domain: nonCombining }), NONE, limits());
    expect(plan.slots).toHaveLength(1);
    expect(plan.blocked).toMatchObject({ code: "SLOT_FULL", unitKeys: ["u004", "u005"] });
  });

  it("order offers need orderDiscounts when other slots exist", () => {
    const units = [unit("order", 1000, { hasOrderRewards: true, domain: { ...nonCombining, productDiscounts: true, orderDiscounts: false } }), ...named(8)];
    const plan = planShards(units, NONE, limits());
    expect(plan.slots).toHaveLength(1);
    expect(plan.blocked?.code).toBe("SLOT_FULL");
  });

  it("orderDiscounts=false is fine when no unit has order rewards", () => {
    const plan = planShards(named(8, 1900, { domain: { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true } }), NONE, limits());
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots.length).toBeGreaterThan(1);
  });

  it("maxSlots = 1 is single-shard mode", () => {
    const plan = planShards(named(6, 2000), NONE, limits(1), POLICY);
    expect(plan.slots).toHaveLength(1);
    expect(plan.blocked?.code).toBe("SLOT_FULL");
  });
});

describe("oversize units", () => {
  it("an unsplittable unit bigger than a slot is blocked with OFFER_TOO_LARGE", () => {
    const plan = planShards([unit("huge", 12000), unit("ok", 500)], NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", unitKeys: ["huge"], reason: "bytes" });
    expect(plan.blocked!.numbers["bytes"]).toBeGreaterThan(12000);
  });

  it("a splittable unit is replaced by its parts", () => {
    const parts = [1, 2, 3].map((k) => unit(`huge#${k}`, 5000, { targetProductIds: [`p${k}`] }));
    const plan = planShards([unit("huge", 15000, { splittable: parts }), unit("ok", 500)], NONE, limits(), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(placedKeys(plan)).toEqual(["huge#1", "huge#2", "huge#3", "ok"]);
    for (const slot of plan.slots) expect(slot.bytes).toBeLessThanOrEqual(9500);
  });

  it("parts that are still too large keep the unit blocked", () => {
    const parts = [unit("huge#1", 11000), unit("huge#2", 11000)];
    const plan = planShards([unit("huge", 22000, { splittable: parts })], NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", unitKeys: ["huge"] });
  });

  it("order-reward units are never split", () => {
    const parts = [unit("o#1", 4000), unit("o#2", 4000)];
    const plan = planShards([unit("o", 12000, { hasOrderRewards: true, splittable: parts })], NONE, limits(), POLICY);
    expect(plan.blocked?.code).toBe("OFFER_TOO_LARGE");
  });

  it("single-shard mode does not split", () => {
    const parts = [unit("huge#1", 5000), unit("huge#2", 5000)];
    const plan = planShards([unit("huge", 12000, { splittable: parts })], NONE, limits(1), POLICY);
    expect(plan.blocked?.code).toBe("OFFER_TOO_LARGE");
  });
});

describe("scale", () => {
  it("packs 300 synthetic units with every slot within the limits and re-plans stably", () => {
    let state = 42;
    const next = (max: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % max;
    };
    const units = Array.from({ length: 300 }, (_, i) =>
      unit(`offer-${String(i).padStart(3, "0")}`, 300 + next(500), {
        priority: 1 + next(40),
        cartAttributeKeys: next(5) === 0 ? [`attr${next(3)}`] : [],
        customerTags: next(4) === 0 ? [`tag-${next(80)}`, `tag-${next(80)}`] : [],
        targetProductIds: [`p${next(200)}`],
      }),
    );
    const plan = planShards(units, NONE, limits(40), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(placedKeys(plan)).toEqual(units.map((u) => u.key).sort());
    expect(plan.slots.length).toBeGreaterThan(10);
    for (const slot of plan.slots) {
      expect(slot.bytes).toBeLessThanOrEqual(9500);
      expect(slot.keys.length).toBeLessThanOrEqual(3);
      expect(slot.tags.length).toBeLessThanOrEqual(100);
    }
    const again = planShards(shuffled(units, 9), assignment(plan), limits(40), POLICY);
    expect(again.moves).toEqual([]);
  });
});

describe("combination domains", () => {
  const NC: CombinationPolicy = { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true };
  const NO_ORDER: CombinationPolicy = { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true };
  const plan = (units: PlanUnit[], previous = NONE, maxSlots = 11) => planShards(units, previous, limits(maxSlots), "domains");
  const ncUnits = (count: number, bytes = 1900) => named(count, bytes, { domain: NC }).map((u) => ({ ...u, key: `nc${u.key}` }));
  const cUnits = (count: number, bytes = 1900) => named(count, bytes).map((u) => ({ ...u, key: `c${u.key}` }));
  const domainOfKey = (units: PlanUnit[], key: string) => units.find((u) => u.key === key)!.domain ?? OPEN_POLICY;

  it("fast path: everything fits one node, so mixed groups stay together with the AND policy (today's single node)", () => {
    const units = [...ncUnits(1, 1000), ...cUnits(2, 1000), unit("o", 500, { domain: NO_ORDER })];
    const result = plan(units);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]!.policy).toEqual({ productDiscounts: false, orderDiscounts: false, shippingDiscounts: true });
    expect(result.moves).toEqual([]);
  });

  it("uniform mode is untouched by domains: a non-combining offer still forces one node", () => {
    const result = planShards([...ncUnits(1), ...cUnits(8)], NONE, limits(), "uniform");
    expect(result.slots).toHaveLength(1);
    expect(result.blocked?.code).toBe("SLOT_FULL");
  });

  it("splits instead of blocking: non-combining offers keep slot 0, combining ones move out", () => {
    const units = [...ncUnits(2), ...cUnits(10)];
    const result = plan(units);
    expect(result.blocked).toBeUndefined();
    expect(result.slots.length).toBeGreaterThan(1);
    expect(slotOf(result, "ncu000")).toBe(0);
    expect(slotOf(result, "ncu001")).toBe(0);
    expect(result.slots[0]!.policy.productDiscounts).toBe(false);
    for (const slot of result.slots.slice(1)) expect(slot.policy).toEqual(OPEN_POLICY);
  });

  it("every node is homogeneous by combination group over shuffled inputs", () => {
    const base = [
      ...ncUnits(5, 1500),
      ...cUnits(20, 1500),
      ...named(6, 1500, { domain: NO_ORDER }).map((u) => ({ ...u, key: `no${u.key}` })),
    ];
    for (const seed of [1, 2, 3, 4, 5]) {
      const units = shuffled(base, seed);
      const result = plan(units);
      expect(result.blocked).toBeUndefined();
      expect(placedKeys(result)).toEqual(units.map((u) => u.key).sort());
      for (const slot of result.slots) {
        for (const key of slot.unitKeys) expect(domainOfKey(units, key)).toEqual(slot.policy);
      }
    }
  });

  it("non-combining offers share as few nodes as possible", () => {
    const result = plan([...ncUnits(7), ...cUnits(7)]);
    const ncSlots = new Set(result.slots.filter((slot) => !slot.policy.productDiscounts).map((slot) => slot.index));
    const ncBytes = 7 * 1900;
    expect(ncSlots.size).toBe(Math.ceil(ncBytes / Math.floor(SLOT_LIMITS.slotBytes * SLOT_LIMITS.targetFill)));
  });

  it("a pinned group with a non-combining offer owns slot 0 and combining units go to shards", () => {
    const units = [
      unit("order", 1000, { hasOrderRewards: true, domain: NC }),
      ...cUnits(8),
    ];
    const result = plan(units);
    expect(result.blocked).toBeUndefined();
    expect(slotOf(result, "order")).toBe(0);
    expect(result.slots[0]!.policy.productDiscounts).toBe(false);
    expect(result.slots[0]!.unitKeys).toEqual(["order"]);
  });

  it("a group tied by multi-line fixed candidates takes the AND of its members", () => {
    const units = [
      unit("quiz", 1000, { multiLineFixed: true, targetProductIds: ["p-x"] }),
      unit("nc", 1000, { domain: NC, targetProductIds: ["p-x"] }),
      ...cUnits(10),
    ];
    const result = plan(units);
    expect(slotOf(result, "quiz")).toBe(slotOf(result, "nc"));
    expect(result.slots.find((slot) => slot.index === slotOf(result, "quiz"))!.policy.productDiscounts).toBe(false);
  });

  it("a split node is sticky: editing one offer moves at most that unit", () => {
    const units = [...ncUnits(2), ...cUnits(14)];
    const first = plan(units);
    const edited = units.map((u) => (u.key === "cu005" ? { ...u, bytes: u.bytes + 300 } : u));
    const again = plan(shuffled(edited, 3), assignment(first));
    expect(again.moves.length).toBeLessThanOrEqual(1);
  });

  it("a domain flip moves only the flipped offer", () => {
    const units = [...ncUnits(2), ...cUnits(14)];
    const first = plan(units);
    const flipped = units.map((u) => (u.key === "cu003" ? { ...u, domain: NC } : u));
    const again = plan(flipped, assignment(first));
    expect(again.moves.map((m) => m.unitKey)).toEqual(["cu003"]);
    expect(again.slots.find((slot) => slot.index === slotOf(again, "cu003"))!.policy.productDiscounts).toBe(false);
  });

  it("removing offers never merges two groups into one node", () => {
    const units = [...ncUnits(6), ...cUnits(12)];
    const first = plan(units);
    const fewer = units.filter((u, i) => i % 3 !== 0);
    const again = plan(fewer, assignment(first));
    for (const slot of again.slots) {
      expect(new Set(slot.unitKeys.map((key) => JSON.stringify(domainOfKey(fewer, key)))).size).toBeLessThanOrEqual(1);
    }
  });

  it("node count stays within the byte optimum plus one per extra group", () => {
    const units = [...ncUnits(9), ...cUnits(25), ...named(7, 1900, { domain: NO_ORDER }).map((u) => ({ ...u, key: `no${u.key}` }))];
    const result = plan(units);
    const soft = Math.floor(SLOT_LIMITS.slotBytes * SLOT_LIMITS.targetFill);
    const total = result.slots.reduce((sum, slot) => sum + slot.bytes, 0);
    expect(result.slots.length).toBeLessThanOrEqual(Math.ceil(total / soft) + 3);
  });

  it("maxSlots 1 stays single in domains mode, with the AND policy", () => {
    const result = plan([...ncUnits(1, 1000), ...cUnits(2, 1000)], NONE, 1);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]!.policy).toEqual(andPolicies([NC, OPEN_POLICY]));
  });
});

describe("Shopify's 100-element list limit", () => {
  it("opens a second node when 101 offers would share one", () => {
    const plan = planShards(named(101, 50), NONE, limits(), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots).toHaveLength(2);
    for (const slot of plan.slots) expect(slot.unitKeys.length).toBeLessThanOrEqual(100);
    expect(placedKeys(plan)).toHaveLength(101);
  });

  it("refuses 101 offers on a single node instead of writing an offers array over the limit", () => {
    const plan = planShards(named(101, 50), NONE, limits(1), POLICY);
    expect(plan.blocked?.code).toBe("SLOT_FULL");
    expect(plan.slots.flatMap((slot) => slot.unitKeys).length).toBeLessThanOrEqual(100);
  });

  it("opens a second node when two offers would bring a node to 101 distinct customer tags", () => {
    const tags = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `tag-${from + i}`);
    const plan = planShards([unit("a", 500, { customerTags: tags(0, 60) }), unit("b", 500, { customerTags: tags(60, 101) })], NONE, limits(), POLICY);
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots).toHaveLength(2);
    for (const slot of plan.slots) expect(slot.tags.length).toBeLessThanOrEqual(100);
  });

  it("blocks one offer that alone references 101 customer tags", () => {
    const plan = planShards([unit("a", 500, { customerTags: Array.from({ length: 101 }, (_, i) => `t${i}`) })], NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({ code: "OFFER_TOO_LARGE", reason: "tags" });
  });

  it("blocks an offer holding a list that cannot be split or packed", () => {
    const plan = planShards([unit("a", 500, { listOverflow: { listKind: 0, listCount: 150 } }), unit("b")], NONE, limits(), POLICY);
    expect(plan.blocked).toMatchObject({
      code: "OFFER_TOO_LARGE",
      unitKeys: ["a"],
      reason: "lists",
      numbers: { listKind: 0, listCount: 150, listLimit: 100 },
    });
    expect(plan.slots).toEqual([]);
  });
});
