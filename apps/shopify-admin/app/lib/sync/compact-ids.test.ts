import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  serializeFunctionConfig,
  type CompiledFunctionConfig,
  type CompiledOffer,
} from "./compile-config.js";
import { unitBytes } from "./shard-planner.js";

const DIR = fileURLToPath(new URL("../../../../../packages/rule-engine/test-fixtures/parity/", import.meta.url));
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const V = (n: number) => `gid://shopify/ProductVariant/${40000000000000 + n}`;
const P = (n: number) => `gid://shopify/Product/${10000000000000 + n}`;

const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${DIR}${name}`, "utf8")) as { name: string; config: CompiledFunctionConfig })
  .map(({ name, config }) => ({
    name,
    config: {
      ...config,
      version: "1",
      shippingOffers: config.shippingOffers ?? [],
      offers: config.offers.map((offer) => ({ ...offer, requirements: offer.requirements ?? [], giftRewards: offer.giftRewards ?? [], productRewards: offer.productRewards ?? [], orderRewards: offer.orderRewards ?? [] })),
    },
  }));

const range = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i));

function heavyOffer(base: CompiledOffer): CompiledOffer {
  return {
    ...base,
    requiredVariantIds: range(20, V),
    anyRequiredProductIds: range(20, P),
    excludedProductIds: range(10, P),
    requirements: [{ productId: P(1), variantId: V(1), trackMode: "variant", minQuantity: 1 }],
    productRewards: [
      {
        ...(base.productRewards[0] ?? { discountType: "percentage", discountValue: 10 }),
        targetVariantIds: range(150, V),
        targetProductIds: range(30, P),
        requiredAnchorVariantIds: range(60, V),
      } as CompiledOffer["productRewards"][number],
    ],
    giftRewards: [
      {
        id: "g",
        targetVariantIds: range(25, V),
        targetProductIds: [],
        discountType: "free",
        discountValue: 100,
        maxQuantity: 1,
      } as unknown as CompiledOffer["giftRewards"][number],
    ],
  };
}

const ID_KEYS: Record<string, "Product" | "ProductVariant"> = {
  requiredProductIds: "Product",
  anyRequiredProductIds: "Product",
  excludedProductIds: "Product",
  targetProductIds: "Product",
  productId: "Product",
  requiredVariantIds: "ProductVariant",
  anyRequiredVariantIds: "ProductVariant",
  targetVariantIds: "ProductVariant",
  requiredAnchorVariantIds: "ProductVariant",
  variantId: "ProductVariant",
};

function expandIds(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => expandIds(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandIds(v, k)]));
  const kind = ID_KEYS[key];
  return kind && typeof value === "string" && /^\d+$/.test(value) ? `gid://shopify/${kind}/${value}` : value;
}

describe("FIX-cap-10 compact ids", () => {
  const withIds = (config: CompiledFunctionConfig) => ({
    ...config,
    offers: config.offers.map(heavyOffer),
    shippingOffers: [
      {
        id: "s",
        title: "ship",
        priority: 1,
        tiers: [],
        requiredAnchorVariantIds: range(5, V),
      } as unknown as CompiledFunctionConfig["shippingOffers"][number],
    ],
  });

  it("is off by default: the config keeps full GIDs", () => {
    expect(serializeFunctionConfig(withIds(fixtures[0]!.config))).toContain("gid://shopify/ProductVariant/");
  });

  it("expands back to the exact old config for every parity fixture", () => {
    for (const { config } of fixtures) {
      for (const input of [config, withIds(config)]) {
        const old = JSON.parse(serializeFunctionConfig(input));
        const compact = JSON.parse(serializeFunctionConfig(input, { compactIds: true }));
        expect(expandIds(compact)).toEqual(old);
      }
    }
  });

  it("leaves non-numeric ids and collection gids untouched", () => {
    const base = fixtures[0]!.config;
    const offer = { ...base.offers[0]!, requiredVariantIds: ["gid://shopify/ProductVariant/12", "legacy-id", "gid://shopify/Collection/5"] };
    const out = JSON.parse(serializeFunctionConfig({ ...base, offers: [offer] }, { compactIds: true }));
    expect(out.offers[0].requiredVariantIds).toEqual(["12", "legacy-id", "gid://shopify/Collection/5"]);
  });

  it("cuts a heavy config by about 40% and a typical one measurably", () => {
    const heavy = withIds(fixtures[0]!.config);
    const heavyOld = bytes(serializeFunctionConfig(heavy));
    const typicalConfig = { ...fixtures[0]!.config, offers: [{ ...heavyOffer(fixtures[0]!.config.offers[0]!), requiredVariantIds: range(2, V), anyRequiredProductIds: [], excludedProductIds: [], productRewards: [], giftRewards: [{ id: "g", targetVariantIds: range(3, V), targetProductIds: [], discountType: "free", discountValue: 100, maxQuantity: 1 } as unknown as CompiledOffer["giftRewards"][number]] }], shippingOffers: [] };
    const typicalOld = bytes(serializeFunctionConfig(typicalConfig));
    const heavyNew = bytes(serializeFunctionConfig(heavy, { compactIds: true }));
    const typicalNew = bytes(serializeFunctionConfig(typicalConfig, { compactIds: true }));
    console.info("compact ids bytes", { heavyOld, heavyNew, typicalOld, typicalNew });
    expect(heavyNew).toBeLessThan(heavyOld * 0.62);
    expect(typicalNew).toBeLessThan(typicalOld - 100);
  });

  it("keeps the planner byte estimate exact with compact ids on", () => {
    const config = withIds(fixtures[0]!.config);
    const serialized = serializeFunctionConfig({ ...config, offers: [config.offers[0]!], shippingOffers: [] }, { compactIds: true });
    const empty = serializeFunctionConfig({ ...config, offers: [], shippingOffers: [] });
    expect(bytes(serialized)).toBe(bytes(empty) + unitBytes(config.offers[0]!, true) - 1);
  });
});
