import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeFunctionConfig, type CompiledFunctionConfig } from "./compile-config.js";
import { planShards, SLOT_LIMITS, unitBytes, type PlanUnit } from "./shard-planner.js";

const DIR = fileURLToPath(new URL("../../../../../packages/rule-engine/test-fixtures/parity/", import.meta.url));
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${DIR}${name}`, "utf8")) as { name: string; config: CompiledFunctionConfig })
  .map(({ name, config }) => ({
    name,
    config: {
      ...config,
      version: "1",
      shippingOffers: [],
      offers: config.offers.map((offer) => ({ ...offer, giftRewards: offer.giftRewards ?? [], productRewards: offer.productRewards ?? [], orderRewards: offer.orderRewards ?? [] })),
    },
  }));

function unitsOf(config: CompiledFunctionConfig): PlanUnit[] {
  const keys = [config.c1, config.c2, config.c3].filter((key): key is string => key !== undefined && key !== "_promo_engine_unused");
  return config.offers.map((offer, index) => ({
    key: offer.id,
    bytes: unitBytes(offer),
    cartAttributeKeys: index === 0 ? keys : [],
    customerTags: index === 0 ? [...(config.customerTags ?? [])] : [],
    priority: offer.priority,
    hasOrderRewards: false,
    stopLowerPriority: false,
    targetProductIds: null,
    multiLineFixed: false,
  }));
}

describe("planner byte estimate vs the serialized cart value (flag off plans one slot)", () => {
  it("covers the parity fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    const { config } = fixture;
    const plan = planShards(unitsOf(config), new Map(), { ...SLOT_LIMITS, maxSlots: 1 });
    expect(plan.blocked).toBeUndefined();
    expect(plan.slots[0]!.bytes).toBe(bytes(serializeFunctionConfig(config)));
  });

  it("holds with three cart attribute keys, customer tags", () => {
    const base = fixtures[0]!.config;
    const config: CompiledFunctionConfig = {
      ...base,
      shippingOffers: [],
      c1: "alpha",
      c2: "beta",
      c3: "gamma",
      customerTags: ["vip", "wholesale"],
    };
    const plan = planShards(unitsOf(config), new Map(), { ...SLOT_LIMITS, maxSlots: 1 });
    expect(plan.slots[0]!.bytes).toBe(bytes(serializeFunctionConfig(config)));
  });
});
