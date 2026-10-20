import { describe, expect, it } from "vitest";
import { DISCOUNT_MESSAGE_MAX_LENGTH, clampDiscountMessage, normalizeOfferTitle, resolveDiscountMessage } from "./discount-message.js";
import { discountMessageText } from "./offer-validation.server.js";

describe("resolveDiscountMessage", () => {
  it("trims, accepts up to the limit and rejects more", () => {
    expect(resolveDiscountMessage("  Spring sale ", "Name")).toEqual({ ok: true, value: "Spring sale" });
    expect(resolveDiscountMessage("a".repeat(DISCOUNT_MESSAGE_MAX_LENGTH), "Name").ok).toBe(true);
    expect(resolveDiscountMessage("a".repeat(DISCOUNT_MESSAGE_MAX_LENGTH + 1), "Name")).toEqual({
      ok: false,
      error: "Discount message can be at most 60 characters.",
    });
  });

  it("falls back to the offer name when empty, and rejects a fallback that is too long", () => {
    expect(resolveDiscountMessage("  ", "Offer name")).toEqual({ ok: true, value: "Offer name" });
    expect(resolveDiscountMessage(null, "Offer name")).toEqual({ ok: true, value: "Offer name" });
    expect(resolveDiscountMessage("", "n".repeat(61)).ok).toBe(false);
  });
});

describe("clampDiscountMessage", () => {
  it("clamps by characters and drops blanks", () => {
    expect(clampDiscountMessage("é".repeat(70))).toBe("é".repeat(60));
    expect(clampDiscountMessage("  ")).toBeUndefined();
    expect(clampDiscountMessage(null)).toBeUndefined();
  });
});

describe("discountMessageText (form validation)", () => {
  const form = (value: string) => {
    const data = new FormData();
    data.set("publicTitle", value);
    return data;
  };
  it("rejects over-limit input and falls back on empty input", () => {
    expect(discountMessageText(form("z".repeat(61)), "Name").error).toMatch(/at most 60/);
    expect(discountMessageText(form(""), "Name")).toEqual({ data: "Name", error: null });
  });
});

describe("normalizeOfferTitle", () => {
  const ch = String.fromCharCode;
  it("lowercases and trims", () => expect(normalizeOfferTitle("  Free Mug ")).toBe("free mug"));
  it("collapses inner whitespace", () => expect(normalizeOfferTitle(`a ${ch(9)}  b${ch(10)} c`)).toBe("a b c"));
  it("applies NFKC to full-width letters and non-breaking spaces", () => {
    expect(normalizeOfferTitle(ch(0xff26, 0xff52, 0xff45, 0xff45))).toBe("free");
    expect(normalizeOfferTitle(`Free${ch(0xa0)}Mug`)).toBe("free mug");
  });
});
