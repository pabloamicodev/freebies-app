import { describe, expect, it } from "vitest";
import { serializeFunctionConfig, type CompiledFunctionConfig } from "./compile-config.js";
import { envelopeBytes, planShards, SLOT_LIMITS, type PlanUnit } from "./shard-planner.js";
import { MERGE_FLAG_BYTES, slotLimitsFor } from "./slot-limits.js";

const config: CompiledFunctionConfig = { offers: [], shippingOffers: [], version: "1", compiledAt: "1970-01-01T00:00:00.000Z" };
const unit = (key: string, bytes: number): PlanUnit => ({
  key,
  bytes,
  cartAttributeKeys: [],
  customerTags: [],
  priority: 10,
  hasOrderRewards: false,
  stopLowerPriority: false,
  targetProductIds: [`p-${key}`],
  multiLineFixed: false,
});

describe("mergeCandidates in the function config", () => {
  it("is absent unless the shop flag asks for it", () => {
    expect(JSON.parse(serializeFunctionConfig(config))).not.toHaveProperty("mergeCandidates");
    expect(JSON.parse(serializeFunctionConfig(config, { mergeCandidates: false }))).not.toHaveProperty("mergeCandidates");
    expect(JSON.parse(serializeFunctionConfig(config, { mergeCandidates: true })).mergeCandidates).toBe(true);
  });

  it("costs exactly MERGE_FLAG_BYTES per node", () => {
    const plain = new TextEncoder().encode(serializeFunctionConfig(config)).byteLength;
    const flagged = new TextEncoder().encode(serializeFunctionConfig(config, { mergeCandidates: true })).byteLength;
    expect(flagged - plain).toBe(MERGE_FLAG_BYTES);
  });

  it("the planner counts it in every slot and in what fits", () => {
    expect(slotLimitsFor(false).envelopeExtraBytes).toBe(0);
    const base = envelopeBytes([], []);
    // One unit that exactly fills the slot without the flag no longer fits with it.
    const filler = unit("a", SLOT_LIMITS.slotBytes - base + 1);
    const off = planShards([filler], new Map(), { ...slotLimitsFor(false), maxSlots: 3 });
    expect(off.blocked).toBeUndefined();
    expect(off.slots[0]!.bytes).toBe(SLOT_LIMITS.slotBytes);
    const on = planShards([filler], new Map(), { ...slotLimitsFor(true), maxSlots: 3 });
    expect(on.blocked?.code).toBe("OFFER_TOO_LARGE");

    const small = planShards([unit("a", 500)], new Map(), { ...slotLimitsFor(true), maxSlots: 3 });
    const plain = planShards([unit("a", 500)], new Map(), { ...slotLimitsFor(false), maxSlots: 3 });
    expect(small.slots[0]!.bytes - plain.slots[0]!.bytes).toBe(MERGE_FLAG_BYTES);
  });
});
