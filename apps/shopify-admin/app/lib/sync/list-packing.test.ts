import { describe, expect, it } from "vitest";
import {
  PACKED_OFFER_KEYS,
  PACKED_REWARD_KEYS,
  SHOPIFY_VARIABLE_LIST_LIMIT,
  serializeFunctionConfig,
  unpackList,
  type CompiledOffer,
  type CompiledShippingOffer,
} from "./compile-config.js";
import { ShardPlanBlockedError } from "./cart-shards.server.js";
import { envelopeBytes, unitBytes } from "./shard-planner.js";
import { assertVariableListsWithinLimit } from "./variable-list-guard.js";

const ids = (count: number, kind = "Product") => Array.from({ length: count }, (_, i) => `gid://shopify/${kind}/${1000 + i}`);

const offer = (extra: Partial<CompiledOffer> = {}): CompiledOffer => ({
  id: "o",
  version: 1,
  offerType: "discount",
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
  ...extra,
});

const reward = (targetProductIds: string[]) =>
  ({
    id: "r",
    targetProductIds,
    targetVariantIds: [],
    discountType: "percentage",
    discountValue: 10,
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
  }) as CompiledOffer["productRewards"][number];

const config = (offers: CompiledOffer[], extra: Record<string, unknown> = {}) => ({
  offers,
  shippingOffers: [] as CompiledShippingOffer[],
  version: "1",
  compiledAt: "t",
  ...extra,
});

type Parsed = {
  offers: Array<Record<string, unknown> & { productRewards?: Array<Record<string, unknown>>; giftRewards?: Array<Record<string, unknown>> }>;
  shippingOffers?: Array<Record<string, unknown>>;
};
const parse = (value: string) => JSON.parse(value) as Parsed;

describe("lists over Shopify's 100-element variable limit are packed", () => {
  it("keeps lists of up to 100 entries as the same JSON arrays", () => {
    const list = ids(SHOPIFY_VARIABLE_LIST_LIMIT);
    const value = serializeFunctionConfig(
      config([offer({ requiredProductIds: list, requiredCustomerTags: list, codeHashes: list, productRewards: [reward(list)] })]),
    );
    const [parsed] = parse(value).offers;
    expect(parsed!["requiredProductIds"]).toEqual(list);
    expect(parsed!["requiredCustomerTags"]).toEqual(list);
    expect(parsed!["codeHashes"]).toEqual(list);
    expect(parsed!.productRewards![0]!["targetProductIds"]).toEqual(list);
    expect(value).toContain(JSON.stringify(list));
  });

  it("packs every packable list from 101 entries into one comma-joined string", () => {
    const list = ids(SHOPIFY_VARIABLE_LIST_LIMIT + 1);
    const everyOfferKey = Object.fromEntries(PACKED_OFFER_KEYS.map((key) => [key, list]));
    const everyRewardKey = Object.fromEntries(PACKED_REWARD_KEYS.map((key) => [key, list]));
    const value = serializeFunctionConfig(
      config([
        offer({
          ...everyOfferKey,
          productRewards: [{ ...reward([]), ...everyRewardKey }],
          giftRewards: [{ ...everyRewardKey, id: "g", discountType: "free", discountValue: 100, maxQuantity: 1 } as never],
        }),
      ]),
    );
    const [parsed] = parse(value).offers;
    for (const key of PACKED_OFFER_KEYS) expect(parsed![key], key).toBe(list.join(","));
    for (const key of PACKED_REWARD_KEYS) {
      expect(parsed!.productRewards![0]![key], key).toBe(list.join(","));
      expect(parsed!.giftRewards![0]![key], key).toBe(list.join(","));
    }
  });

  it("packs compact ids and unpacks back to the same ids", () => {
    const list = ids(140);
    const value = serializeFunctionConfig(config([offer({ productRewards: [reward(list)] })]), { compactIds: true });
    const packed = parse(value).offers[0]!.productRewards![0]!["targetProductIds"];
    expect(typeof packed).toBe("string");
    expect(unpackList(packed)).toEqual(list.map((id) => id.split("/").pop()));
  });

  it("packs 150 code hashes in the code config", () => {
    const hashes = Array.from({ length: 150 }, (_, i) => `h${i.toString(16).padStart(14, "0")}`);
    const value = serializeFunctionConfig(config([offer({ codeHashes: hashes })]), { omitCartAttributeSlots: true });
    expect(parse(value).offers[0]!["codeHashes"]).toBe(hashes.join(","));
    expect(() => assertVariableListsWithinLimit(value)).not.toThrow();
  });

  it("never packs the delivery config", () => {
    const hashes = Array.from({ length: 150 }, (_, i) => `h${i}`);
    const shipping = {
      id: "s",
      priority: 1,
      tiers: [],
      targetGroupTypes: [],
      scopeMode: "sitewide",
      requiredAnchorVariantIds: ids(150, "ProductVariant"),
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: false,
      codeHashes: hashes,
    } as unknown as CompiledShippingOffer;
    const value = serializeFunctionConfig({ ...config([]), shippingOffers: [shipping] }, { omitQueryVariables: true });
    const [parsed] = parse(value).shippingOffers!;
    expect(parsed!["codeHashes"]).toEqual(hashes);
    expect(Array.isArray(parsed!["requiredAnchorVariantIds"])).toBe(true);
    expect(() => assertVariableListsWithinLimit(value)).not.toThrow();
  });

  it("measures the packed size: slot bytes still equal the serialized config", () => {
    const offers = [offer({ id: "a", productRewards: [reward(ids(600))] }), offer({ id: "b", requiredProductIds: ids(101) })];
    const serialized = serializeFunctionConfig(config(offers, { compiledAt: "1970-01-01T00:00:00.000Z" }));
    const expected = envelopeBytes([], []) + offers.reduce((sum, o) => sum + unitBytes(o), 0) - 1;
    expect(expected).toBe(new TextEncoder().encode(serialized).byteLength);
  });

  it("unpackList accepts arrays, packed strings and nothing", () => {
    expect(unpackList(["a", "b"])).toEqual(["a", "b"]);
    expect(unpackList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(unpackList("")).toEqual([]);
    expect(unpackList(undefined)).toEqual([]);
  });
});

describe("assertVariableListsWithinLimit", () => {
  const capacityOf = (value: string) => {
    try {
      assertVariableListsWithinLimit(value);
    } catch (error) {
      expect(error).toBeInstanceOf(ShardPlanBlockedError);
      return (error as ShardPlanBlockedError).capacity;
    }
    return null;
  };

  it("passes packed and short configs", () => {
    expect(capacityOf(serializeFunctionConfig(config([offer({ productRewards: [reward(ids(600))] })])))).toBeNull();
  });

  it("refuses an offer array over 100", () => {
    const value = JSON.stringify({ offers: Array.from({ length: 101 }, (_, i) => ({ id: `o${i}` })), version: "1" });
    expect(capacityOf(value)).toMatchObject({ code: "OFFER_TOO_LARGE", numbers: { listCount: 101, listLimit: 100 } });
  });

  it("refuses a list inside an offer and names that offer", () => {
    const requirements = Array.from({ length: 101 }, () => ({ trackMode: "any", minQuantity: 1 }));
    const value = JSON.stringify({ offers: [{ id: "ok" }, { id: "big", requirements }] });
    expect(capacityOf(value)).toMatchObject({ offerIds: ["big"], numbers: { listCount: 101, listLimit: 100 } });
  });

  it("refuses more than 100 customer tags (a real GraphQL list variable)", () => {
    const value = serializeFunctionConfig(config([], { customerTags: Array.from({ length: 101 }, (_, i) => `t${i}`) }));
    expect(capacityOf(value)).toMatchObject({ code: "OFFER_TOO_LARGE", numbers: { listCount: 101 } });
  });
});
