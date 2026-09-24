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
