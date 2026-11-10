import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNPACKABLE_LISTS } from "./unpackable-lists.js";
import { listKindOf } from "./compile-config.js";

describe("unpackable lists", () => {
  it("is imported by the browser-reachable capacity copy without going through the server-only compiler", () => {
    const source = readFileSync(new URL("../capacity-copy.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/compile-config/);
    expect(source).toMatch(/unpackable-lists/);
  });

  it("keeps listKindOf aligned with the table", () => {
    expect(listKindOf("customerTags")).toBe(UNPACKABLE_LISTS.length - 1);
  });
});
