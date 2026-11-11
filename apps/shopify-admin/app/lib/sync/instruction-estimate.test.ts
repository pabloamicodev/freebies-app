import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALIBRATED,
  estimateNodeInstructions,
  factInstructions,
  FACT_QTY,
  FACT_VALUE,
  NODE_EMPTY_INSTRUCTIONS,
  offerFacts,
  ownKey,
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
  it("budgets 8M per node including the floor", () => {
    expect(NODE_INSTRUCTION_BUDGET).toBe(8_000_000);
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
    for (const own of Object.values(CALIBRATED.shapes)) expect(Number.isFinite(own)).toBe(true);
    for (const name of Object.keys(measured.nodes)) {
      for (const offer of specOffers(name)) {
        const cost = estimateUnitInstructions(offer as never);
        expect(cost).toBeGreaterThanOrEqual(0);
        expect(estimateUnitInstructions(offer as never)).toBe(cost);
      }
    }
  });

  it("a node with no offers costs only the empty run; the first offer adds the shared reads once", () => {
    expect(estimateNodeInstructions([])).toBe(NODE_EMPTY_INSTRUCTIONS);
    expect(NODE_INSTRUCTION_FLOOR).toBe(NODE_EMPTY_INSTRUCTIONS + CALIBRATED.base);
    const gift = { offerType: "gift", giftRewards: [{}] } as never;
    expect(estimateNodeInstructions([gift, gift])).toBe(NODE_INSTRUCTION_FLOOR + 2 * estimateUnitInstructions(gift));
  });

  it("charges each shared fact once per node, however many offers need it", () => {
    const quantity = { offerType: "gift", giftRewards: [{}], cartQuantityThreshold: 2 } as never;
    const value = { offerType: "gift", giftRewards: [{}], cartValueThresholdCents: 5000 } as never;
    expect(offerFacts(quantity)).toBe(FACT_QTY);
    expect(offerFacts(value)).toBe(FACT_VALUE);
    const own = (offer: never) => estimateUnitInstructions(offer);
    expect(estimateNodeInstructions([quantity, quantity, quantity])).toBe(NODE_INSTRUCTION_FLOOR + factInstructions(FACT_QTY) + 3 * own(quantity));
    expect(estimateNodeInstructions([quantity, value])).toBe(
      NODE_INSTRUCTION_FLOOR + factInstructions(FACT_QTY | FACT_VALUE) + own(quantity) + own(value),
    );
  });

  it("an offer capped below the cart's unit count never fires on a 200-line cart and costs only its checks", () => {
    const idle = { offerType: "discount", orderRewards: [{}], cartQuantityThreshold: 1, cartQuantityMax: 1 } as never;
    const live = { offerType: "discount", orderRewards: [{}], cartQuantityThreshold: 4 } as never;
    expect(ownKey(idle)).toBe("idle");
    expect(ownKey(live)).toBe("order");
    expect(estimateUnitInstructions(idle)).toBeLessThan(estimateUnitInstructions(live));
  });

  it("estimates every live node within 1.3x of its measurement", () => {
    for (const [name, node] of Object.entries(measured.nodes)) {
      if (node.offers === 0) continue;
      expect(estimateNodeInstructions(specOffers(name) as never[]) / node.measured, name).toBeLessThanOrEqual(1.3);
    }
  });
});
