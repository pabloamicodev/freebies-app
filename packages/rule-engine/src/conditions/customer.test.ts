import { describe, it, expect } from "vitest";
import { evaluateOrderHistory, evaluateMarket } from "./customer.js";
import type { NormalizedCustomer } from "@promo/shared-types";

function makeCustomer(overrides: Partial<NormalizedCustomer> = {}): NormalizedCustomer {
  return {
    id: "cust-1",
    email: "test@example.com",
    tags: [],
    totalSpentCents: 0,
    totalOrders: 0,
    lastOrderSpentCents: null,
    countryCode: null,
    isFirstTimeCustomer: false,
    ...overrides,
  };
}

describe("evaluateOrderHistory", () => {
  it("fails closed when there is no customer", () => {
    const result = evaluateOrderHistory(null, { type: "total_orders", operator: "gte", valueOrders: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.conditionType).toBe("order_history");
  });

  it("treats a missing last-order-spent value as 0", () => {
    const customer = makeCustomer({ lastOrderSpentCents: null });
    const result = evaluateOrderHistory(customer, { type: "last_order_spent", operator: "eq", valueCents: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actual).toBe(0);
  });

  describe.each([
    ["gte", 10, 10, true],
    ["gte", 9, 10, false],
    ["gte", 11, 10, true],
    ["lte", 10, 10, true],
    ["lte", 11, 10, false],
    ["lte", 9, 10, true],
    ["gt", 10, 10, false],
    ["gt", 11, 10, true],
    ["gt", 9, 10, false],
    ["lt", 10, 10, false],
    ["lt", 9, 10, true],
    ["lt", 11, 10, false],
    ["eq", 10, 10, true],
    ["eq", 9, 10, false],
    ["eq", 11, 10, false],
  ] as const)("operator %s (actual=%d, required=%d)", (operator, actual, required, expected) => {
    it(`passes=${expected}`, () => {
      const customer = makeCustomer({ totalOrders: actual });
      const result = evaluateOrderHistory(customer, { type: "total_orders", operator, valueOrders: required });
      expect(result.ok).toBe(expected);
    });
  });

  it("compares total spent in cents", () => {
    const customer = makeCustomer({ totalSpentCents: 5000 });
    expect(evaluateOrderHistory(customer, { type: "total_spent", operator: "gte", valueCents: 5000 }).ok).toBe(true);
    expect(evaluateOrderHistory(customer, { type: "total_spent", operator: "gt", valueCents: 5000 }).ok).toBe(false);
  });
});

describe("evaluateMarket", () => {
  it("passes when no include/exclude lists are configured", () => {
    expect(evaluateMarket("market-1", {}).ok).toBe(true);
    expect(evaluateMarket(null, {}).ok).toBe(true);
  });

  it("passes when the market is in the include list", () => {
    const result = evaluateMarket("market-1", { includeMarketIds: ["market-1", "market-2"] });
    expect(result.ok).toBe(true);
  });

  it("fails when the market is not in a non-empty include list", () => {
    const result = evaluateMarket("market-3", { includeMarketIds: ["market-1", "market-2"] });
    expect(result.ok).toBe(false);
  });

  it("fails when marketId is null and an include list is configured", () => {
    const result = evaluateMarket(null, { includeMarketIds: ["market-1"] });
    expect(result.ok).toBe(false);
  });

  it("treats an empty include list as no restriction", () => {
    const result = evaluateMarket("market-1", { includeMarketIds: [] });
    expect(result.ok).toBe(true);
  });

  it("fails when the market is in the exclude list", () => {
    const result = evaluateMarket("market-1", { excludeMarketIds: ["market-1"] });
    expect(result.ok).toBe(false);
  });

  it("treats an empty exclude list as no restriction", () => {
    const result = evaluateMarket("market-1", { excludeMarketIds: [] });
    expect(result.ok).toBe(true);
  });

  it("exclude wins when a market id is present in both include and exclude lists", () => {
    // Include is checked first and would pass "market-1" through, but the
    // exclude check runs unconditionally afterward and rejects it — so
    // exclude takes precedence on overlap.
    const result = evaluateMarket("market-1", {
      includeMarketIds: ["market-1"],
      excludeMarketIds: ["market-1"],
    });
    expect(result.ok).toBe(false);
  });
});
