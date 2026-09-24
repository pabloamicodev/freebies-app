import { afterEach, describe, expect, it, vi } from "vitest";
import {
  intervalToDurationMonths,
  listActiveSkioSubscriptions,
  setSkioDeliveryPriceOverride,
  subscriptionProductVariantIds,
  subscriptionSubtotal,
  validateSkioApiKey,
  type RawSkioSubscription,
  type SkioGraphQLProxy,
} from "./skio-api.server.js";

const VARIANT = "gid://shopify/ProductVariant/1";

function subscription(overrides: Partial<RawSkioSubscription> = {}): RawSkioSubscription {
  return {
    id: "sub-1",
    status: "ACTIVE",
    cyclesCompleted: 1,
    nextBillingDate: "2026-10-01T00:00:00Z",
    deliveryPrice: 4.99,
    BillingPolicy: { interval: "DAY", intervalCount: 90 },
    SubscriptionLines: [
      { priceWithoutDiscount: 25, quantity: 2, removedAt: null, ProductVariant: { platformId: VARIANT } },
    ],
    ...overrides,
  };
}

describe("Skio API adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("paginates active subscriptions until a short page is returned", async () => {
    const offsets: number[] = [];
    const proxy: SkioGraphQLProxy = async <T>(query: string, variables?: Record<string, unknown>) => {
      expect(query).toContain("ListActiveSubscriptions");
      const offset = Number(variables?.["offset"] ?? 0);
      offsets.push(offset);
      const rows = offset === 0
        ? Array.from({ length: 100 }, (_, index) => subscription({ id: `sub-${index}` }))
        : [subscription({ id: "sub-last" })];
      return { data: { Subscriptions: rows } as T };
    };
    const result = await listActiveSkioSubscriptions(proxy);
    expect(result).toHaveLength(101);
    expect(offsets).toEqual([0, 100]);
  });

  it("sends decimal delivery prices without converting to cents", async () => {
    let input: unknown;
    const proxy: SkioGraphQLProxy = async <T>(_query: string, variables?: Record<string, unknown>) => {
      input = variables?.["input"];
      return { data: { setDeliveryPriceOverride: { subscriptionId: "sub-1" } } as T };
    };
    await setSkioDeliveryPriceOverride(proxy, "sub-1", 1.99);
    expect(input).toEqual({ subscriptionId: "sub-1", deliveryPrice: 1.99 });
  });

  it("fails closed on GraphQL errors or empty mutation results", async () => {
    const graphqlError: SkioGraphQLProxy = async () => ({ errors: [{ message: "not allowed" }] });
    await expect(listActiveSkioSubscriptions(graphqlError)).rejects.toThrow(/ListActiveSubscriptions failed/);

    const emptyMutation: SkioGraphQLProxy = async <T>() => ({ data: { setDeliveryPriceOverride: null } as T });
    await expect(setSkioDeliveryPriceOverride(emptyMutation, "sub-1", 0)).rejects.toThrow(/returned no result/);
  });

  it("normalizes duration, subtotal, and active variant ids", () => {
    const row = subscription({
      SubscriptionLines: [
        { priceWithoutDiscount: 25, quantity: 2, removedAt: null, ProductVariant: { platformId: VARIANT } },
        { priceWithoutDiscount: 999, quantity: 1, removedAt: "2026-01-01", ProductVariant: { platformId: "removed" } },
      ],
    });
    expect(intervalToDurationMonths(row.BillingPolicy)).toBe(3);
    expect(intervalToDurationMonths({ interval: "MONTH", intervalCount: 3 })).toBeNull();
    expect(subscriptionSubtotal(row)).toBe(50);
    expect(subscriptionProductVariantIds(row)).toEqual([VARIANT]);
  });

  it("validates credentials with a bounded one-row query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: { Subscriptions: [] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateSkioApiKey("private-key")).resolves.toEqual({ ok: true });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      query: expect.stringContaining("Subscriptions(limit: 1)"),
    });
  });
});
