import { describe, expect, it } from "vitest";
import { evaluateUrlParam } from "./url-param.js";

describe("evaluateUrlParam", () => {
  it("matches a custom path and query parameter", () => {
    const result = evaluateUrlParam("https://shop.example/pages/vip?code=summer", {
      requiredUrl: "/pages/vip",
      paramName: "code",
      paramValue: "summer",
    });

    expect(result.ok).toBe(true);
  });

  it("supports legacy param/key records while stored offers are migrated", () => {
    const result = evaluateUrlParam("https://shop.example/?freegifts_code=summer", {
      requiredUrl: "",
      param: "freegifts_code",
      value: "summer",
    });

    expect(result.ok).toBe(true);
  });
});

describe("evaluateUrlParam on stamped relative page URLs (D3)", () => {
  it("matches a relative path + query, which new URL() cannot parse", () => {
    const condition = { requiredUrl: "https://shop.example/pages/vip", paramName: "code", paramValue: "SUMMER" };
    expect(evaluateUrlParam("/pages/vip?code=SUMMER", condition).ok).toBe(true);
    expect(evaluateUrlParam("/en/pages/VIP?x=1&code=SUMMER", condition).ok).toBe(true);
    expect(evaluateUrlParam("/pages/vip?code=summer", condition).ok).toBe(false);
    expect(evaluateUrlParam("/pages/other?code=SUMMER", condition).ok).toBe(false);
  });

  it("decodes names and values and keeps utm_ case-insensitive", () => {
    expect(evaluateUrlParam("/?gift+code=a%26b", { paramName: "gift code", paramValue: "a&b" }).ok).toBe(true);
    expect(evaluateUrlParam("/?UTM_Source=Amazon", { paramName: "utm_source", paramValue: "amazon" }).ok).toBe(true);
  });
});
