import { describe, expect, it } from "vitest";
import { isEligibleBundlePage } from "./bundle-page-eligibility.js";

describe("isEligibleBundlePage", () => {
  it("allows bundles without URL restrictions", () => {
    expect(isEligibleBundlePage(null, [])).toBe(true);
  });

  it("requires every enabled page and link condition to match", () => {
    const conditions = [
      {
        conditionType: "page_url",
        value: { patterns: ["/pages/vip"], matchMode: "exact", caseSensitive: false },
      },
      {
        conditionType: "specific_link",
        value: { requiredUrl: "/pages/vip", paramName: "code", paramValue: "summer" },
      },
    ];

    expect(isEligibleBundlePage("https://shop.example/pages/vip?code=summer", conditions)).toBe(
      true,
    );
    expect(isEligibleBundlePage("https://shop.example/pages/vip?code=winter", conditions)).toBe(
      false,
    );
    expect(isEligibleBundlePage("https://shop.example/pages/general?code=summer", conditions)).toBe(
      false,
    );
  });

  it("fails closed when a stored URL condition is malformed or URL context is absent", () => {
    expect(
      isEligibleBundlePage("https://shop.example/pages/vip", [
        {
          conditionType: "page_url",
          value: { patterns: [], matchMode: "exact", caseSensitive: false },
        },
      ]),
    ).toBe(false);
    expect(
      isEligibleBundlePage(null, [
        { conditionType: "specific_link", value: { requiredUrl: "/pages/vip" } },
      ]),
    ).toBe(false);
  });
});
