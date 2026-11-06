import { describe, expect, it } from "vitest";
import { ShardPlanBlockedError } from "./cart-shards.server.js";
import type { PlanBlocked } from "./shard-planner.js";

const slotFull: PlanBlocked = {
  code: "SLOT_FULL",
  unitKeys: ["o1", "o2"],
  numbers: { slotBytes: 9500, neededBytes: 12000, overflowUnits: 1 },
};

describe("ShardPlanBlockedError combination mapping", () => {
  it("maps SLOT_FULL to COMBINATION_SINGLE_SHARD when blockers forced the single shard", () => {
    const error = new ShardPlanBlockedError(slotFull, {
      shardsEnabled: true,
      names: new Map([["o1", "Sitewide"], ["o2", "Other"]]),
      combinationBlockers: [{ offerId: "o1", name: "Sitewide" }],
    });
    expect(error.capacity).toEqual({
      code: "COMBINATION_SINGLE_SHARD",
      offerIds: ["o1"],
      numbers: { bytes: 12000, slotBytes: 9500, offersBlocking: 1 },
      reason: "combination",
    });
    expect(error.message).toContain("don't combine with other product discounts");
    expect(error.message).toContain('"Sitewide"');
  });

  it("keeps SLOT_FULL without blockers", () => {
    const error = new ShardPlanBlockedError(slotFull, { shardsEnabled: true, names: new Map([["o1", "A"]]) });
    expect(error.capacity.code).toBe("SLOT_FULL");
    expect(error.message).toContain("over the 9500B limit");
  });
});
