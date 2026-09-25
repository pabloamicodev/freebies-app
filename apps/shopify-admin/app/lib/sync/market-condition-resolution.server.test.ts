import { describe, expect, it } from "vitest";
import type { OfferCondition } from "@promo/db";
import type { ShopifyMarket } from "./market-sync.server.js";
import { resolveMarketConditionsToCountries } from "./market-condition-resolution.server.js";

function condition(value: unknown): OfferCondition {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    shopId: "22222222-2222-4222-8222-222222222222",
    offerId: "33333333-3333-4333-8333-333333333333",
    scope: "sub",
    conditionType: "markets",
    operator: "in",
    value,
    sortOrder: 1,
    isEnabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function market(overrides: Partial<ShopifyMarket>): ShopifyMarket {
  return {
    id: "gid://shopify/Market/1",
    name: "North America",
    handle: "north-america",
    enabled: true,
    primary: false,
    currencyCode: "USD",
    countryCodes: ["US", "CA"],
    primaryLocale: "en",
    ...overrides,
  };
}

describe("resolveMarketConditionsToCountries", () => {
  it("resolves included and excluded regional Markets to deduplicated countries", () => {
    const result = resolveMarketConditionsToCountries(
      [
        condition({
          includeMarketIds: ["gid://shopify/Market/1", "gid://shopify/Market/2"],
          excludeMarketIds: ["gid://shopify/Market/3"],
        }),
      ],
      [
        market({}),
        market({ id: "gid://shopify/Market/2", name: "Americas", countryCodes: ["CA", "MX"] }),
        market({ id: "gid://shopify/Market/3", name: "Europe", countryCodes: ["FR", "DE"] }),
      ],
    );

    expect(result[0]).toMatchObject({
      conditionType: "customer_location",
      value: {
        includeCountryCodes: ["CA", "MX", "US"],
        excludeCountryCodes: ["DE", "FR"],
      },
    });
  });

  it("fails closed for an unknown, inactive, or regionless Market", () => {
    expect(() =>
      resolveMarketConditionsToCountries(
        [condition({ includeMarketIds: ["gid://shopify/Market/missing"], excludeMarketIds: [] })],
        [market({})],
      ),
    ).toThrow(/unknown included Market/);
    expect(() =>
      resolveMarketConditionsToCountries(
        [condition({ includeMarketIds: ["gid://shopify/Market/1"], excludeMarketIds: [] })],
        [market({ enabled: false })],
      ),
    ).toThrow(/inactive included Market/);
    expect(() =>
      resolveMarketConditionsToCountries(
        [condition({ includeMarketIds: ["gid://shopify/Market/1"], excludeMarketIds: [] })],
        [market({ countryCodes: [] })],
      ),
    ).toThrow(/no country regions/);
  });

  it("leaves disabled Market and unrelated conditions unchanged", () => {
    const disabled = {
      ...condition({ includeMarketIds: [], excludeMarketIds: [] }),
      isEnabled: false,
    };
    const cartValue = { ...condition({ thresholdCents: 5000 }), conditionType: "cart_value" };
    const visibility = {
      ...condition({ includeMarketIds: [], excludeMarketIds: [] }),
      scope: "visibility" as const,
    };
    expect(resolveMarketConditionsToCountries([disabled, cartValue, visibility], [])).toEqual([
      disabled,
      cartValue,
      visibility,
    ]);
  });
});
