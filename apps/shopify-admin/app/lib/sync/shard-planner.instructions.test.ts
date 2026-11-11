import { describe, expect, it } from "vitest";
import { planShards, SLOT_LIMITS, type PlanUnit, type PlannerLimits, type ShardPlan } from "./shard-planner.js";

const CAP = 3_000_000;
const limits = (extra: Partial<PlannerLimits> = {}): PlannerLimits => ({ ...SLOT_LIMITS, maxSlots: 11, maxInstructions: CAP, ...extra });
const byteLimits = (maxSlots = 11): PlannerLimits => ({ ...SLOT_LIMITS, maxSlots });
const NONE = new Map<string, number>();

const unit = (key: string, instructions: number, extra: Partial<PlanUnit> = {}): PlanUnit => ({
  key,
  bytes: 900,
  instructions,
  cartAttributeKeys: [],
  customerTags: [],
  priority: 100,
  hasOrderRewards: false,
  stopLowerPriority: false,
  targetProductIds: [`p-${key}`],
  multiLineFixed: false,
  ...extra,
});

const layout = (plan: ShardPlan) => plan.slots.map((slot) => slot.unitKeys);
const sums = (plan: ShardPlan, units: PlanUnit[]) =>
  plan.slots.map((slot) => slot.unitKeys.reduce((total, key) => total + (units.find((candidate) => candidate.key === key)?.instructions ?? 0), 0));
const previousOf = (plan: ShardPlan) => new Map(plan.slots.flatMap((slot) => slot.unitKeys.map((key) => [key, slot.index] as const)));

describe("planShards with an instruction budget", () => {
  it("spreads a heavy shop over more nodes, none over the budget", () => {
    const units = ["a", "b", "c", "d", "e", "f"].map((key) => unit(key, 1_400_000));
    expect(planShards(units, NONE, byteLimits()).slots).toHaveLength(1);
    const plan = planShards(units, NONE, limits());
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sums(plan, units))).toBeLessThanOrEqual(CAP);
    expect(plan.slots.map((slot) => slot.instructions)).toEqual(sums(plan, units));
    expect(plan.warnings).toBeUndefined();
  });

  it("leaves a light shop exactly as the byte planner plans it", () => {
    const units = Array.from({ length: 12 }, (_, index) => unit(`u${String(index).padStart(2, "0")}`, 100_000));
    const bytes = planShards(units, NONE, byteLimits());
    const plan = planShards(units, NONE, limits());
    expect(layout(plan)).toEqual(layout(bytes));
    expect(plan.moves).toEqual(bytes.moves);
    expect(plan.warnings).toBeUndefined();
  });

  it("without maxInstructions the unit costs are ignored", () => {
    const units = ["a", "b", "c"].map((key) => unit(key, 50_000_000));
    expect(planShards(units, NONE, byteLimits()).slots).toHaveLength(1);
  });

  it("falls back to the byte plan with a warning when the budget needs more nodes than allowed, never blocking", () => {
    const units = ["a", "b", "c", "d", "e", "f"].map((key) => unit(key, 2_500_000));
    const bytes = planShards(units, NONE, byteLimits(2));
    const plan = planShards(units, NONE, limits({ maxSlots: 2 }));
    expect(plan.blocked).toBeUndefined();
    expect(layout(plan)).toEqual(layout(bytes));
    expect(plan.warnings?.map((warning) => warning.code)).toEqual(["INSTRUCTION_BUDGET_UNREACHABLE", "INSTRUCTION_BUDGET_EXCEEDED"]);
    expect(plan.warnings![0]!.numbers).toMatchObject({ budget: CAP, allowedSlots: 2 });
  });

  it("does not hide a real byte block behind the instruction fallback", () => {
    const units = [unit("a", 100, { bytes: SLOT_LIMITS.slotBytes + 1 })];
    const plan = planShards(units, NONE, limits());
    expect(plan.blocked?.code).toBe("OFFER_TOO_LARGE");
  });

  it("keeps a unit bigger than the budget alone in a node of its own and reports it", () => {
    const units = [unit("big", 5_000_000), unit("a", 1_000_000), unit("b", 1_000_000)];
    const plan = planShards(units, NONE, limits());
    expect(plan.blocked).toBeUndefined();
    const home = plan.slots.find((slot) => slot.unitKeys.includes("big"))!;
    expect(home.unitKeys).toEqual(["big"]);
    expect(plan.warnings?.map((warning) => warning.code)).toEqual(["INSTRUCTION_BUDGET_EXCEEDED"]);
    expect(plan.warnings![0]!.slots).toEqual([home.index]);
  });

  it("counts colocated units (C5) as one bundle: they stay together even over the budget", () => {
    const units = [
      unit("q1", 2_000_000, { multiLineFixed: true, targetProductIds: ["shared"] }),
      unit("q2", 2_000_000, { targetProductIds: ["shared"] }),
      unit("x", 1_000_000),
    ];
    const plan = planShards(units, NONE, limits());
    expect(plan.blocked).toBeUndefined();
    const together = plan.slots.find((slot) => slot.unitKeys.includes("q1"))!;
    expect(together.unitKeys).toContain("q2");
    expect(plan.warnings?.map((warning) => warning.code)).toContain("INSTRUCTION_BUDGET_EXCEEDED");
  });

  it("moves only what an over-budget node must give up, the costliest unit first, and nothing else", () => {
    const before = [unit("a", 1_200_000), unit("b", 1_200_000), unit("c", 1_200_000), unit("d", 1_200_000)];
    const first = planShards(before, NONE, limits());
    expect(first.slots).toHaveLength(2);
    const grown = before.map((candidate) => (candidate.key === "a" ? { ...candidate, instructions: 2_400_000 } : candidate));
    const again = planShards(grown, previousOf(first), limits());
    expect(again.blocked).toBeUndefined();
    expect(Math.max(...sums(again, grown))).toBeLessThanOrEqual(CAP);
    expect(again.moves).toHaveLength(1);
    expect(again.moves[0]!.unitKey).toBe("a");
    const untouched = first.slots.find((slot) => !slot.unitKeys.includes("a"))!;
    for (const key of untouched.unitKeys) expect(previousOf(again).get(key)).toBe(untouched.index);
  });

  it("an unchanged shop on a second publish moves nothing", () => {
    const units = ["a", "b", "c", "d", "e", "f"].map((key) => unit(key, 1_400_000));
    const first = planShards(units, NONE, limits());
    const second = planShards(units, previousOf(first), limits());
    expect(second.moves).toEqual([]);
    expect(layout(second)).toEqual(layout(first));
  });

  it("respects combination groups: offers of different groups never share a node", () => {
    const open = { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true };
    const solo = { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true };
    const units = [
      ...["a", "b", "c", "d"].map((key) => unit(key, 1_400_000, { domain: open })),
      ...["s1", "s2"].map((key) => unit(key, 1_400_000, { domain: solo })),
    ];
    const plan = planShards(units, NONE, limits(), "domains");
    expect(plan.blocked).toBeUndefined();
    for (const slot of plan.slots) {
      const groups = new Set(slot.unitKeys.map((key) => units.find((candidate) => candidate.key === key)!.domain!.productDiscounts));
      expect(groups.size).toBe(1);
    }
    expect(Math.max(...sums(plan, units))).toBeLessThanOrEqual(CAP);
  });

  it("only warns when everything must share one node anyway", () => {
    const units = ["a", "b", "c"].map((key) => unit(key, 2_000_000));
    const plan = planShards(units, NONE, limits({ maxSlots: 1 }));
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots).toHaveLength(1);
    expect(plan.warnings?.map((warning) => warning.code)).toEqual(["INSTRUCTION_BUDGET_EXCEEDED"]);
  });
});
