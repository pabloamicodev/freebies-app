import { describe, expect, it } from "vitest";
import { decideAutoOpen, resolveGiftChoices } from "./gift-slider.js";
import type { GiftSliderPayload, SelectableGift } from "../types.js";

const gift = (variantId: string, over: Partial<SelectableGift> = {}): SelectableGift => ({
  rewardId: "r1",
  offerVersion: 1,
  rewardMaxQuantity: 1,
  variantId,
  productId: "p",
  title: "Tee",
  variantTitle: variantId,
  imageUrl: null,
  originalPriceCents: 2000,
  discountedPriceCents: 0,
  isAvailable: true,
  isSelected: false,
  ...over,
});

const payload = (primaries: SelectableGift[], fallbackGifts?: SelectableGift[]): GiftSliderPayload => ({
  offerId: "o1",
  title: "Gift",
  subtitle: null,
  currencyCode: "USD",
  selectableGifts: [...primaries, ...(fallbackGifts ?? []).map((g) => ({ ...g, isFallback: true }))],
  maxSelectableCount: 1,
  alreadySelectedCount: 0,
});

const ids = (gifts: SelectableGift[]) => gifts.map((g) => g.variantId);

describe("resolveGiftChoices", () => {
  it("keeps primaries (dimmed by the caller) while at least one is purchasable", () => {
    const p = payload([gift("a"), gift("b")], [gift("f1")]);
    expect(ids(resolveGiftChoices(p, new Set(["a"])))).toEqual(["a", "b"]);
  });

  it("swaps in fallbacks when every primary is sold out per the payload", () => {
    const p = payload([gift("a", { isAvailable: false }), gift("b", { isAvailable: false })], [gift("f1"), gift("f2")]);
    expect(ids(resolveGiftChoices(p))).toEqual(["f1", "f2"]);
  });

  it("swaps in fallbacks when live stock sold out every primary the cache called available", () => {
    const p = payload([gift("a"), gift("b")], [gift("f1")]);
    expect(ids(resolveGiftChoices(p, new Set(["a", "b"])))).toEqual(["f1"]);
  });

  it("swaps in fallbacks for a single-variant gift rejected with a 422", () => {
    expect(ids(resolveGiftChoices(payload([gift("a")], [gift("f1")]), new Set(["a"])))).toEqual(["f1"]);
  });

  it("skips fallbacks that are unavailable or live sold out", () => {
    const p = payload([gift("a")], [gift("f1", { isAvailable: false }), gift("f2"), gift("f3")]);
    expect(ids(resolveGiftChoices(p, new Set(["a", "f2"])))).toEqual(["f3"]);
  });

  it("returns nothing (no dead modal) when primaries and fallbacks are all sold out", () => {
    expect(resolveGiftChoices(payload([gift("a")], [gift("f1")]), new Set(["a", "f1"]))).toEqual([]);
    expect(resolveGiftChoices(payload([gift("a", { isAvailable: false })]))).toEqual([]);
  });

  it("keeps a sold-out primary the customer already has in the cart", () => {
    const p = payload([gift("a", { isAvailable: false, isSelected: true })], [gift("f1")]);
    expect(ids(resolveGiftChoices(p))).toEqual(["a"]);
  });

  it("resolves each reward independently", () => {
    const p = payload([gift("a", { isAvailable: false }), gift("b", { rewardId: "r2" })], [gift("f1")]);
    expect(ids(resolveGiftChoices(p))).toEqual(["f1", "b"]);
  });
});

describe("decideAutoOpen with fallbacks", () => {
  const none = new Set<string>();
  const q1 = new Set(["o1"]);
  const sold = () => payload([gift("a", { isAvailable: false })], [gift("f1")]);

  it("down-up crossing with primaries OOS and fallback in stock reopens the picker (showing the fallback)", () => {
    const first = decideAutoOpen(none, [sold()], q1, none);
    expect(first.open).toHaveLength(1);
    expect(ids(resolveGiftChoices(first.open[0]!))).toEqual(["f1"]);
    const dipped = decideAutoOpen(first.keys, [], new Set(), none);
    const again = decideAutoOpen(dipped.keys, [sold()], q1, none);
    expect(again.open).toHaveLength(1);
    expect(ids(resolveGiftChoices(again.open[0]!))).toEqual(["f1"]);
  });

  it("does not open when primaries and fallbacks are all unavailable", () => {
    const dead = payload([gift("a", { isAvailable: false })], [gift("f1", { isAvailable: false })]);
    expect(decideAutoOpen(none, [dead], q1, none).open).toEqual([]);
  });

  it("does not open when the fallback's reward was declined", () => {
    expect(decideAutoOpen(none, [sold()], q1, new Set(["o1:r1"])).open).toEqual([]);
  });
});
