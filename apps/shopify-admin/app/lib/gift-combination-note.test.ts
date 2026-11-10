import { describe, expect, it } from "vitest";
import { GIFT_NOT_COMBINING_NOTE, showGiftRemovalNote } from "./gift-combination-note.js";

describe("gift combination note", () => {
  it("shows only for a gift offer that does not combine with product discounts", () => {
    expect(showGiftRemovalNote("gift", false)).toBe(true);
    expect(showGiftRemovalNote("gift", true)).toBe(false);
    expect(showGiftRemovalNote("discount", false)).toBe(false);
    expect(showGiftRemovalNote("bundle", false)).toBe(false);
  });
  it("says what happens to the gift", () => {
    expect(GIFT_NOT_COMBINING_NOTE).toBe("If a bigger discount wins at checkout, this gift is removed from the cart.");
  });
});
