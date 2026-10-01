import { describe, expect, it } from "vitest";
import { codeHash } from "./code-hash.js";

describe("codeHash", () => {
  // Same vectors as the Rust test in extensions/code-discount-function.
  it.each([
    ["SUMMER10", "9e35947c8d25"],
    ["VIP-2026", "e8cf18d732cc"],
    ["A", "af63fc4c8602"],
    ["AMAZON_PROMO", "5f2c120b2677"],
  ])("hashes %s", (code, expected) => {
    expect(codeHash(code)).toBe(expected);
  });

  it("is case and whitespace insensitive", () => {
    expect(codeHash("  summer10 ")).toBe(codeHash("SUMMER10"));
  });
});
