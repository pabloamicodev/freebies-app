import { describe, expect, it } from "vitest";
import { cleanExcludeUrl, cleanPageHandle, pageHandleToUrl, pageUrlToHandle, pageTypeLabel } from "./page-types.js";

describe("Pages handle input", () => {
  it.each([
    ["bundle-builder", "/bundle-builder"],
    ["/bundle-builder", "/bundle-builder"],
    ["/pages/bundle-builder", "/bundle-builder"],
    ["pages/bundle-builder", "/bundle-builder"],
    ["https://gettrusupps.com/pages/bundle-builder", "/bundle-builder"],
    ["https://gettrusupps.com/pages/bundle-builder/?a=1#x", "/bundle-builder"],
    ["/bundle-builder/", "/bundle-builder"],
    ["  ", ""],
    ["", ""],
    ["/", ""],
    ["/pages", ""],
    ["/pages/", ""],
  ])("%j -> %j", (raw, handle) => {
    expect(cleanPageHandle(raw, true)).toBe(handle);
  });

  it("keeps in-progress typing intact", () => {
    expect(cleanPageHandle("pages")).toBe("/pages");
    expect(cleanPageHandle("/a/")).toBe("/a/");
    expect(cleanPageHandle("a")).toBe("/a");
  });

  it("maps handle <-> stored full path", () => {
    expect(pageHandleToUrl("/bundle-builder")).toBe("/pages/bundle-builder");
    expect(pageHandleToUrl("https://x.com/pages/a?b=1")).toBe("/pages/a");
    expect(pageHandleToUrl("")).toBe("");
    expect(pageUrlToHandle("/pages/bundle-builder")).toBe("/bundle-builder");
  });

  it.each([
    ["https://onesol.com/products/x", "/products/x"],
    ["https://onesol.com/products/x/?variant=1#a", "/products/x"],
    ["//onesol.com/products/x", "/products/x"],
    ["products/x", "/products/x"],
    ["/products/x/", "/products/x"],
    ["/products/x?v=1", "/products/x"],
    ["/en/collections/a/products/x", "/en/collections/a/products/x"],
    ["  ", ""],
    ["/", ""],
    ["https://onesol.com", ""],
  ])("exclude input %j -> %j on blur", (raw, path) => {
    expect(cleanExcludeUrl(raw, true)).toBe(path);
  });

  it("converts a pasted URL while typing but leaves partial paths alone", () => {
    expect(cleanExcludeUrl("https://onesol.com/products/x")).toBe("/products/x");
    expect(cleanExcludeUrl("products/")).toBe("/products/");
    expect(cleanExcludeUrl("/products/x?")).toBe("/products/x?");
  });

  it("labels the type Pages", () => {
    expect(pageTypeLabel("page")).toBe("Pages");
  });
});
