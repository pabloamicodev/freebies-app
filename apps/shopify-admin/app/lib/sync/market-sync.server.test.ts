import { describe, expect, it } from "vitest";
import { MARKETS_QUERY, mapMarketNode } from "./market-sync.server.js";

describe("Shopify Markets sync", () => {
  it("uses the current regionsCondition query shape", () => {
    expect(MARKETS_QUERY).toContain("regionsCondition");
    expect(MARKETS_QUERY).toContain("... on MarketRegionCountry");
    expect(MARKETS_QUERY).not.toContain("allMarkets");
    expect(MARKETS_QUERY).not.toContain("countries {");
    expect(MARKETS_QUERY).not.toContain(" primary");
  });

  it("maps real Market ids and country codes", () => {
    expect(mapMarketNode({
      id: "gid://shopify/Market/123",
      name: "Europe",
      handle: "europe",
      status: "ACTIVE",
      currencySettings: { baseCurrency: { currencyCode: "EUR" } },
      conditions: {
        regionsCondition: {
          regions: {
            nodes: [
              { __typename: "MarketRegionCountry", code: "DE" },
              { __typename: "MarketRegionSubdivision", code: "FR-IDF", country: { code: "FR" } },
            ],
          },
        },
      },
      webPresences: { nodes: [{ defaultLocale: { locale: "de" } }] },
    })).toEqual({
      id: "gid://shopify/Market/123",
      name: "Europe",
      handle: "europe",
      enabled: true,
      primary: false,
      currencyCode: "EUR",
      countryCodes: ["DE", "FR"],
      primaryLocale: "de",
    });
  });
});
