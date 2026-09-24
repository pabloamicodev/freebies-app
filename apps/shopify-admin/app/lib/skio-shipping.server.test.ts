import { beforeEach, describe, expect, it, vi } from "vitest";

const { shopifyGraphQLMock } = vi.hoisted(() => ({ shopifyGraphQLMock: vi.fn() }));
vi.mock("./shopify-fetch.server.js", () => ({ shopifyGraphQL: shopifyGraphQLMock }));

import {
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
    shopifyGraphQLMock.mockResolvedValueOnce({ shop: { id: "gid://shopify/Shop/1", config: null } });
    await expect(loadSkioShippingConfig(client)).resolves.toEqual({ config: { tiers: [] }, configValid: true, configError: null });

    shopifyGraphQLMock.mockResolvedValueOnce({ shop: { id: "gid://shopify/Shop/1", config: { jsonValue: { tiers: [{ id: "bad" }] } } } });
    const invalid = await loadSkioShippingConfig(client);
    expect(invalid.configValid).toBe(false);
    expect(invalid.config.tiers).toEqual([]);
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
