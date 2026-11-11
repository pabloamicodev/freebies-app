import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateNodeInstructions, estimateUnitInstructions, INSTRUCTION_PLANNER_LIMITS, offerFacts } from "./instruction-estimate.js";
import { planShards, SLOT_LIMITS, type PlanUnit } from "./shard-planner.js";

const SPECS = resolve(__dirname, "../../../extensions/discount-function/src/fixtures/instructions");
type SpecOffer = Record<string, unknown> & { id: string; priority: number; orderRewards?: unknown[]; stopLowerPriority?: boolean };
const offersOf = (name: string) => (JSON.parse(readFileSync(resolve(SPECS, `${name}.json`), "utf8")) as { config: { offers: SpecOffer[] } }).config.offers;

const unitsOf = (offers: SpecOffer[]): PlanUnit[] =>
  offers.map((offer) => ({
    key: offer.id,
    bytes: JSON.stringify(offer).length + 1,
    instructions: estimateUnitInstructions(offer as never),
    instructionFacts: offerFacts(offer as never),
    cartAttributeKeys: [],
    customerTags: [],
    priority: offer.priority,
    hasOrderRewards: (offer.orderRewards?.length ?? 0) > 0,
    stopLowerPriority: offer.stopLowerPriority === true,
    targetProductIds: [],
    multiLineFixed: false,
  }));

const NONE = new Map<string, number>();
const limits = (maxSlots: number) => ({ ...SLOT_LIMITS, maxSlots, ...INSTRUCTION_PLANNER_LIMITS });

describe("the live specs under the instruction budget (200 lines, 8M per node)", () => {
  // Owner-chosen budget of 8M: both OneSol nodes stay as they are (7.02M and 5.95M estimated), Ambrosia and TRU go to two nodes.
  // (At 7M TRU needed three nodes and OneSol slot 0 two.)
  const expected: Record<string, number> = { "tru-slot0": 2, "ambrosia-slot0": 2, "onesol-slot0": 1, "onesol-slot1": 1, "hpn-slot0": 1 };

  for (const [name, nodes] of Object.entries(expected)) {
    it(`${name} plans to ${nodes} node(s); every node is under the budget unless it holds one bundle`, () => {
      const offers = offersOf(name);
      const plan = planShards(unitsOf(offers), NONE, limits(11), "domains");
      expect(plan.blocked).toBeUndefined();
      expect(plan.slots.length).toBe(nodes);
      for (const slot of plan.slots) {
        const members = offers.filter((offer) => slot.unitKeys.includes(offer.id));
        if (slot.unitKeys.length > 1) expect(estimateNodeInstructions(members as never[])).toBeLessThanOrEqual(8_000_000);
      }
    });
  }

  it("a shop that already runs one node keeps it when the estimate fits, moving nothing", () => {
    const units = unitsOf(offersOf("onesol-slot1"));
    const previous = new Map(units.map((unit) => [unit.key, 0]));
    const plan = planShards(units, previous, limits(11), "domains");
    expect(plan.moves).toEqual([]);
  });
});

describe("the last automatic-discount slot", () => {
  it("is never consumed by the instruction pass: with the reserve all that is left the plan falls back to bytes and warns", () => {
    // maxSlots is what the shop may still use after the reserve; the instruction pass would need one more than that.
    const units = unitsOf(offersOf("tru-slot0"));
    const bytesOnly = planShards(units, NONE, { ...SLOT_LIMITS, maxSlots: 1 }, "domains");
    expect(bytesOnly.slots).toHaveLength(1);
    const plan = planShards(units, NONE, limits(1), "domains");
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots.map((slot) => slot.unitKeys)).toEqual(bytesOnly.slots.map((slot) => slot.unitKeys));
    expect(plan.warnings?.map((warning) => warning.code)).toContain("INSTRUCTION_BUDGET_EXCEEDED");
  });

  it("with exactly the slots the budget needs it spreads without warnings; with one fewer it keeps one node and only reports it", () => {
    const units = unitsOf(offersOf("tru-slot0"));
    const spread = planShards(units, NONE, limits(11), "domains");
    expect(spread.slots).toHaveLength(2);
    const tight = planShards(units, NONE, limits(2), "domains");
    expect(tight.slots).toHaveLength(2);
    expect(tight.warnings).toBeUndefined();
    const short = planShards(units, NONE, limits(1), "domains");
    expect(short.blocked).toBeUndefined();
    expect(short.slots).toHaveLength(1);
    expect(short.warnings?.map((warning) => warning.code)).toEqual(["INSTRUCTION_BUDGET_EXCEEDED"]);
  });
});
