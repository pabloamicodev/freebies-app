import { describe, expect, it } from "vitest";
import { compileOfferCartMessage, compileTierCartMessage, readCartLabels, resolveCartLabels } from "./cart-labels.js";

describe("cart labels", () => {
  it("trims, drops empties and duplicates", () => {
    expect(resolveCartLabels(JSON.stringify([" A ", "", "A", "B"]))).toEqual({ ok: true, labels: ["A", "B"] });
    expect(resolveCartLabels("")).toEqual({ ok: true, labels: [] });
    expect(resolveCartLabels(undefined)).toEqual({ ok: true, labels: [] });
  });

  it("rejects more than 3 labels, labels over 40 chars and malformed input", () => {
    expect(resolveCartLabels(["a", "b", "c", "d"]).ok).toBe(false);
    expect(resolveCartLabels(["x".repeat(41)]).ok).toBe(false);
    expect(resolveCartLabels("{nope").ok).toBe(false);
    expect(resolveCartLabels({}).ok).toBe(false);
  });

  it("reads stored labels defensively", () => {
    expect(readCartLabels("nope")).toEqual([]);
    expect(readCartLabels([" a ", 3, "", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });

  it("compiles messages only when labels exist", () => {
    expect(compileOfferCartMessage("Sale", [])).toBeUndefined();
    expect(compileOfferCartMessage("Sale", ["A", "B"])).toBe("Sale \u00b7 A \u00b7 B");
    expect(compileOfferCartMessage(undefined, ["A"])).toBe("A");
    expect(compileTierCartMessage(undefined)).toBeUndefined();
    expect(compileTierCartMessage(["20% OFF"])).toBe("20% OFF");
  });
});
