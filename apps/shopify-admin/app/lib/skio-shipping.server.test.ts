import { beforeEach, describe, expect, it, vi } from "vitest";

const { shopifyGraphQLMock } = vi.hoisted(() => ({ shopifyGraphQLMock: vi.fn() }));
vi.mock("./shopify-fetch.server.js", () => ({ shopifyGraphQL: shopifyGraphQLMock }));

import {
  addSkioShippingTier,
  deleteSkioShippingTier,
  loadSkioShippingConfig,
  saveSkioShippingConfig,
  upsertSkioShippingTier,
} from "./skio-shipping-config.server.js";
import { DeliveryPriceOverrideVerificationError, runSkioShippingSync } from "./skio-shipping-runner.server.js";
import type { RawSkioSubscription, SkioGraphQLProxy } from "./skio-api.server.js";
import type { SkioShippingTiersConfig } from "./skio-shipping-tiers.js";

const client = { shopDomain: "example.myshopify.com", accessToken: "token" };
const config: SkioShippingTiersConfig = {
  tiers: [{
    id: "three-month-over-50",
    name: "Three months over $50",
    subscriptionDurationMonths: 3,
    minSubtotal: 50,
    maxSubtotal: null,
    productVariantIds: null,
    cycleOverrides: [{ cycle: 1, override: { amount: 0 } }],
    defaultOverride: { amount: 1.99 },
  }],
};

function rawSubscription(overrides: Partial<RawSkioSubscription> = {}): RawSkioSubscription {
  return {
    id: "sub-1",
    status: "ACTIVE",
    cyclesCompleted: 1,
    nextBillingDate: "2026-10-01T00:00:00Z",
    deliveryPrice: 6.99,
    BillingPolicy: { interval: "DAY", intervalCount: 90 },
    SubscriptionLines: [{
      priceWithoutDiscount: 60,
      quantity: 1,
      removedAt: null,
      ProductVariant: { platformId: "gid://shopify/ProductVariant/1" },
    }],
    ...overrides,
  };
}

describe("Skio shipping configuration", () => {
  beforeEach(() => shopifyGraphQLMock.mockReset());

  it("reads app-owned JSON and falls back safely when it is missing or invalid", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: { id: "gid://shopify/Shop/1", config: null, legacyConfig: null },
    });
    await expect(loadSkioShippingConfig(client)).resolves.toEqual({
      config: { tiers: [] },
      configValid: true,
      configError: null,
      importedFromLegacy: false,
    });

    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: {
        id: "gid://shopify/Shop/1",
        config: { jsonValue: { tiers: [{ id: "bad" }] } },
        legacyConfig: null,
      },
    });
    const invalid = await loadSkioShippingConfig(client);
    expect(invalid.configValid).toBe(false);
    expect(invalid.config.tiers).toEqual([]);
  });

  it("imports the legacy hpn_scripts shop metafield as a one-time fallback when $app is empty", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: { id: "gid://shopify/Shop/1", config: null, legacyConfig: { jsonValue: config } },
    });
    await expect(loadSkioShippingConfig(client)).resolves.toEqual({
      config,
      configValid: true,
      configError: null,
      importedFromLegacy: true,
    });
  });

  it("ignores an empty or invalid legacy metafield and stays on the empty $app config", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: { id: "gid://shopify/Shop/1", config: null, legacyConfig: { jsonValue: { tiers: [] } } },
    });
    await expect(loadSkioShippingConfig(client)).resolves.toEqual({
      config: { tiers: [] },
      configValid: true,
      configError: null,
      importedFromLegacy: false,
    });

    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: { id: "gid://shopify/Shop/1", config: null, legacyConfig: { jsonValue: { tiers: [{ id: "bad" }] } } },
    });
    await expect(loadSkioShippingConfig(client)).resolves.toMatchObject({ importedFromLegacy: false });
  });

  it("never falls back to legacy once $app already has its own config", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      shop: {
        id: "gid://shopify/Shop/1",
        config: { jsonValue: config },
        legacyConfig: { jsonValue: { tiers: [] } },
      },
    });
    await expect(loadSkioShippingConfig(client)).resolves.toEqual({
      config,
      configValid: true,
      configError: null,
      importedFromLegacy: false,
    });
  });

  it("writes a validated value through metafieldsSet", async () => {
    shopifyGraphQLMock
      .mockResolvedValueOnce({ shop: { id: "gid://shopify/Shop/1" } })
      .mockResolvedValueOnce({ metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] } });
    await expect(saveSkioShippingConfig(client, config)).resolves.toEqual({ userErrors: [] });
    const mutation = shopifyGraphQLMock.mock.calls[1]?.[0] as { variables: { metafields: Array<Record<string, unknown>> } };
    expect(mutation.variables.metafields[0]).toMatchObject({
      ownerId: "gid://shopify/Shop/1",
      key: "skio_shipping_tiers",
      type: "json",
      value: JSON.stringify(config),
    });
  });

  it("upserts and deletes tiers without mutating the input", () => {
    const original = { tiers: [...config.tiers] };
    const updatedTier = { ...config.tiers[0]!, name: "Renamed" };
    expect(upsertSkioShippingTier(original, updatedTier).tiers[0]?.name).toBe("Renamed");
    expect(original.tiers[0]?.name).toBe("Three months over $50");
    expect(deleteSkioShippingTier(original, "three-month-over-50").tiers).toEqual([]);
  });

  it("adds new tiers but refuses to overwrite an existing ID", () => {
    const newTier = { ...config.tiers[0]!, id: "six-month", name: "Six months" };
    expect(addSkioShippingTier(config, newTier)).toEqual({ config: { tiers: [...config.tiers, newTier] } });
    expect(addSkioShippingTier(config, { ...newTier, id: "three-month-over-50" })).toEqual({
      error: 'A Skio shipping tier with ID "three-month-over-50" already exists.',
    });
  });
});

describe("Skio shipping synchronization", () => {
  it("writes and verifies the effective delivery price", async () => {
    let row = rawSubscription();
    const proxy: SkioGraphQLProxy = async <T>(query: string, variables?: Record<string, unknown>) => {
      if (query.includes("ListActiveSubscriptions")) return { data: { Subscriptions: [row] } as T };
      if (query.includes("SetDeliveryPriceOverride")) {
        row = { ...row, deliveryPrice: Number((variables?.["input"] as { deliveryPrice: number }).deliveryPrice) };
        return { data: { setDeliveryPriceOverride: { subscriptionId: row.id } } as T };
      }
      if (query.includes("GetSkioSubscription")) return { data: { SubscriptionByPk: row } as T };
      throw new Error("Unexpected query");
    };
    await expect(runSkioShippingSync(proxy, config)).resolves.toEqual([
      expect.objectContaining({ overrideAmount: 1.99, applied: true }),
    ]);
  });

  it("halts when a write cannot be verified", async () => {
    const row = rawSubscription();
    const proxy: SkioGraphQLProxy = async <T>(query: string) => {
      if (query.includes("ListActiveSubscriptions")) return { data: { Subscriptions: [row] } as T };
      if (query.includes("SetDeliveryPriceOverride")) return { data: { setDeliveryPriceOverride: { subscriptionId: row.id } } as T };
      if (query.includes("GetSkioSubscription")) return { data: { SubscriptionByPk: row } as T };
      throw new Error("Unexpected query");
    };
    await expect(runSkioShippingSync(proxy, config)).rejects.toBeInstanceOf(DeliveryPriceOverrideVerificationError);
  });
});
