import { describe, expect, it } from "vitest";
import { buildMarketContext } from "./market-context.js";

describe("buildMarketContext", () => {
  it("uses the Shopify Market GID instead of treating currency as a market id", () => {
    expect(buildMarketContext(
      {
        marketId: "gid://shopify/Market/123",
        marketHandle: "europe",
        countryCode: "DE",
        currency: "USD",
        locale: "en",
      },
      { currency: { active: "EUR", rate: "0.92" }, locale: "de" },
    )).toEqual({
      id: "gid://shopify/Market/123",
      handle: "europe",
      currencyCode: "EUR",
      countryCode: "DE",
      primaryLocale: "de",
      exchangeRate: 0.92,
    });
  });

  it("still sends the primary market when the active currency is the shop currency", () => {
    expect(buildMarketContext(
      {
        marketId: "gid://shopify/Market/1",
        marketHandle: "primary",
        countryCode: "US",
        currency: "USD",
        locale: "en",
      },
      { currency: { active: "USD", rate: "1" } },
    )?.id).toBe("gid://shopify/Market/1");
  });

  it("converts the numeric market id Liquid renders into a GID", () => {
    expect(buildMarketContext(
      { marketId: 30959829075, marketHandle: "us", countryCode: "US", currency: "USD", locale: "en" },
      undefined,
    )?.id).toBe("gid://shopify/Market/30959829075");
  });
});
