import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALIBRATED,
  estimateNodeInstructions,
  estimateUnitInstructions,
  INSTRUCTION_LINES,
  NODE_INSTRUCTION_BUDGET,
  NODE_INSTRUCTION_FLOOR,
  NODE_UNIT_INSTRUCTION_BUDGET,
  offerShape,
} from "./instruction-estimate.js";

const SPECS = resolve(__dirname, "../../../extensions/discount-function/src/fixtures/instructions");
const measured = JSON.parse(readFileSync(resolve(__dirname, "instruction-estimate.measured.json"), "utf8")) as {
  nodes: Record<string, { offers: number; measured: number }>;
};
const specOffers = (name: string) => (JSON.parse(readFileSync(resolve(SPECS, `${name}.json`), "utf8")) as { config: { offers: Array<Record<string, unknown>> } }).config.offers;

describe("instruction estimate", () => {
  it("budgets 7M per node including the floor", () => {
    expect(NODE_INSTRUCTION_BUDGET).toBe(7_000_000);
    expect(NODE_UNIT_INSTRUCTION_BUDGET).toBe(NODE_INSTRUCTION_BUDGET - NODE_INSTRUCTION_FLOOR);
    expect(NODE_UNIT_INSTRUCTION_BUDGET).toBeGreaterThan(0);
    expect(INSTRUCTION_LINES).toBe(200);
  });

  it("never undershoots a measured live node (200 lines, worst of plain/promo cart)", () => {
    for (const [name, node] of Object.entries(measured.nodes)) {
      const offers = specOffers(name);
      expect(offers).toHaveLength(node.offers);
      expect(estimateNodeInstructions(offers as never[]), name).toBeGreaterThanOrEqual(node.measured);
    }
  });

  it("classifies offers by what they do, including the compact serialized form", () => {
    expect(offerShape({ offerType: "gift", giftRewards: [] })).toBe("gift");
    expect(offerShape({ offerType: "discount", giftRewards: [{}] as never })).toBe("gift");
    expect(offerShape({ productRewards: [{ scopeMode: "quiz_bundle" }] })).toBe("quiz");
    expect(offerShape({ productRewards: [{ scopeMode: "landing" }] })).toBe("landing");
    expect(offerShape({ productRewards: [{ scopeMode: "tagged_offer" }] })).toBe("landing");
    expect(offerShape({ productRewards: [{ scopeMode: "sitewide", quantityTiers: [{}] }] })).toBe("tiers");
    expect(offerShape({ productRewards: [{ scopeMode: "sitewide", priceTiers: [{}] }] })).toBe("tiers");
    expect(offerShape({ productRewards: [{ scopeMode: "sitewide" }] })).toBe("discount");
    expect(offerShape({ orderRewards: [{}] as never, productRewards: [] })).toBe("order");
    expect(offerShape({})).toBe("discount");
  });

  it("is a pure function of the offer and never negative", () => {
    for (const shape of Object.keys(CALIBRATED.shapes)) expect(Number.isFinite(CALIBRATED.shapes[shape as keyof typeof CALIBRATED.shapes].a)).toBe(true);
    for (const name of Object.keys(measured.nodes)) {
      for (const offer of specOffers(name)) {
        const cost = estimateUnitInstructions(offer as never);
        expect(cost).toBeGreaterThanOrEqual(0);
        expect(estimateUnitInstructions(offer as never)).toBe(cost);
      }
    }
  });

  it("a node with no offers costs the floor", () => {
    expect(estimateNodeInstructions([])).toBe(NODE_INSTRUCTION_FLOOR);
  });
});
