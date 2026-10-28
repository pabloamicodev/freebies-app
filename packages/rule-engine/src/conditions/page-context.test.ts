import { describe, expect, it } from "vitest";
import { classifyPageType, evaluatePageTypes, evaluateUtmParameters } from "./page-context.js";

describe("classifyPageType (mirrors the Function's page_type)", () => {
  it.each([
    ["/", "home"],
    ["", "home"],
    ["/?utm_source=x", "home"],
    ["/en", "home"],
    ["/fr-ca/", "home"],
    ["/products/shirt", "product"],
    ["/es/products/shirt?variant=1", "product"],
    ["/collections/sale/products/shirt", "product"],
    ["/en-us/collections/sale/products/shirt", "product"],
    ["/collections", "collection"],
    ["/collections/sale", "collection"],
    ["/de/collections/sale/tag", "collection"],
    ["/search?q=shirt", "search"],
    ["/pages/about", "page"],
    ["/blogs/news/post", "blog"],
    ["/cart", "cart"],
    ["/EN/Products/Shirt", "product"],
    ["https://shop.example/en/pages/vip?x=1", "page"],
    ["/account", null],
    ["/policies/refund-policy", null],
    ["/eng/products/x", null],
  ])("%s → %s", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });
});

describe("evaluatePageTypes", () => {
  it("passes only for a selected page type", () => {
    expect(evaluatePageTypes("/products/x", { pageTypes: ["product", "cart"] }).ok).toBe(true);
    expect(evaluatePageTypes("/", { pageTypes: ["product"] }).ok).toBe(false);
    expect(evaluatePageTypes("/account", { pageTypes: ["home"] }).ok).toBe(false);
    expect(evaluatePageTypes(null, { pageTypes: ["home"] }).ok).toBe(false);
  });

  it("restricts the page type to the listed URLs and leaves the other types alone", () => {
    const value = { pageTypes: ["home", "product", "page"] as const, pageUrls: ["/Pages/Bundle-Builder/", "https://x.com/pages/other?a=1"] };
    const check = (url: string | null) => evaluatePageTypes(url, { ...value, pageTypes: [...value.pageTypes] }).ok;
    expect(check("/pages/bundle-builder")).toBe(true);
    expect(check("/en/pages/bundle-builder")).toBe(false);
    expect(check("/PAGES/Bundle-Builder/?x=1")).toBe(true);
    expect(check("/pages/other")).toBe(true);
    expect(check("/pages/landing")).toBe(false);
    expect(check("/")).toBe(true);
    expect(check("/products/x")).toBe(true);
    expect(check("/cart")).toBe(false);
  });

  it("rejects excluded paths for every kind, over the listed pages, and keeps the rest", () => {
    const value = {
      pageTypes: ["home", "product", "page"] as Array<"home" | "product" | "page">,
      pageUrls: ["/pages/landing"],
      excludeUrls: ["/products/x", "/pages/landing", "https://s.com/Products/One-Sol%E2%84%A2-1/?v=1"],
    };
    const check = (url: string | null) => evaluatePageTypes(url, value).ok;
    expect(check("/products/x")).toBe(false);
    expect(check("/PRODUCTS/X/?a=1")).toBe(false);
    expect(check("/fr-ca/products/x")).toBe(false);
    expect(check("/pages/landing")).toBe(false);
    expect(check("/products/one-sol%E2%84%A2-1")).toBe(false);
    expect(check("/products/one-sol™-1")).toBe(false);
    expect(check("/products/x-2")).toBe(true);
    expect(check("/collections/c/products/x")).toBe(true);
    expect(check("/")).toBe(true);
    expect(evaluatePageTypes("/products/x", { pageTypes: ["product"], excludeUrls: [] }).ok).toBe(true);
  });

  it("keeps any page when the list is empty or Pages is not selected", () => {
    expect(evaluatePageTypes("/pages/landing", { pageTypes: ["page"], pageUrls: [" "] }).ok).toBe(true);
    expect(evaluatePageTypes("/pages/landing", { pageTypes: ["page"] }).ok).toBe(true);
    expect(evaluatePageTypes("/pages/x", { pageTypes: ["home"], pageUrls: ["/pages/x"] }).ok).toBe(false);
  });
});

describe("evaluateUtmParameters", () => {
  it("compares raw query values against the encoded expectation, like the Function", () => {
    const value = { utmSource: "amazon", utmCampaign: "prime day" };
    expect(evaluateUtmParameters("/?utm_source=amazon&utm_campaign=prime%20day", value).ok).toBe(true);
    expect(evaluateUtmParameters("/?utm_source=amazon", value).ok).toBe(false);
    expect(evaluateUtmParameters("/?utm_source=google&utm_campaign=prime%20day", value).ok).toBe(false);
    expect(evaluateUtmParameters(null, value).ok).toBe(false);
  });
});

describe("D3 URL handling", () => {
  it("decodes + and %20 as spaces and compares utm_* ASCII case-insensitively", () => {
    const value = { utmCampaign: "summer sale", utmSource: "fb/ig" };
    expect(evaluateUtmParameters("/?utm_campaign=Summer+Sale&UTM_SOURCE=fb%2Fig", value).ok).toBe(true);
    expect(evaluateUtmParameters("/?utm_campaign=summer%2Bsale&utm_source=fb%2Fig", value).ok).toBe(false);
  });

  it("does not mistake a :// inside the query for a scheme", () => {
    expect(classifyPageType("/products/x?next=https://a.com/pages/y")).toBe("product");
    expect(classifyPageType("//shop.example/pages/y")).toBe("page");
    expect(classifyPageType("shop.example/pages/y")).toBe(null);
  });
});
