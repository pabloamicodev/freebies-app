import { describe, expect, it } from "vitest";
import { cleanPageHandle, pageHandleToUrl, pageUrlToHandle, pageTypeLabel } from "./page-types.js";

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

  it("labels the type Pages", () => {
    expect(pageTypeLabel("page")).toBe("Pages");
  });
});
