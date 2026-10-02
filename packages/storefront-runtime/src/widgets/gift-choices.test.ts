import { describe, expect, it } from "vitest";
import { decideAutoOpen, resolveGiftChoices, toggleGiftSelection } from "./gift-slider.js";
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

describe("toggleGiftSelection", () => {
  it("switches sizes with one click when only one gift can be chosen", () => {
    const gifts = [gift("L"), gift("XL")];
    const selected = new Set(["r1:L"]);
    expect(toggleGiftSelection(selected, gifts[1]!, gifts, 1)).toEqual(new Set(["r1:XL"]));
    expect(selected).toEqual(new Set(["r1:L"]));
  });

  it("replaces the same reward's selection while preserving other rewards at the global limit", () => {
    const gifts = [gift("L"), gift("XL"), gift("bottle", { rewardId: "r2" })];
    const selected = new Set(["r1:L", "r2:bottle"]);
    expect(toggleGiftSelection(selected, gifts[1]!, gifts, 2)).toEqual(new Set(["r2:bottle", "r1:XL"]));
  });

  it("can switch rewards when the whole offer allows only one gift", () => {
    const gifts = [gift("tee"), gift("bottle", { rewardId: "r2" })];
    expect(toggleGiftSelection(new Set(["r1:tee"]), gifts[1]!, gifts, 1)).toEqual(new Set(["r2:bottle"]));
  });

  it("does not replace a selection with a gift unavailable in the payload or live stock", () => {
    const selected = new Set(["r1:L"]);
    const unavailable = gift("XL", { isAvailable: false });
    expect(toggleGiftSelection(selected, unavailable, [gift("L"), unavailable], 1)).toBeNull();
    expect(toggleGiftSelection(selected, gift("XL"), [gift("L"), gift("XL")], 1, new Set(["XL"]))).toBeNull();
    expect(selected).toEqual(new Set(["r1:L"]));
  });

  it("deselects a selected gift, including one that has sold out", () => {
    const selected = new Set(["r1:L", "r2:bottle"]);
    const unavailable = gift("L", { isAvailable: false });
    expect(toggleGiftSelection(selected, unavailable, [unavailable], 2)).toEqual(new Set(["r2:bottle"]));
  });

  it("still enforces the global limit when adding a different reward", () => {
    const gifts = [gift("L"), gift("bottle", { rewardId: "r2" }), gift("bag", { rewardId: "r3" })];
    expect(toggleGiftSelection(new Set(["r1:L", "r2:bottle"]), gifts[2]!, gifts, 2)).toBeNull();
  });

  it("keeps multiple selections up to the reward cap and refuses overflow", () => {
    const gifts = [gift("L", { rewardMaxQuantity: 2 }), gift("XL", { rewardMaxQuantity: 2 }), gift("M", { rewardMaxQuantity: 2 })];
    const selected = toggleGiftSelection(new Set(["r1:L"]), gifts[1]!, gifts, 3)!;
    expect(selected).toEqual(new Set(["r1:L", "r1:XL"]));
    expect(toggleGiftSelection(selected, gifts[2]!, gifts, 3)).toBeNull();
  });

  it("does not select a gift when either configured limit is zero", () => {
    expect(toggleGiftSelection(new Set(), gift("L"), [gift("L")], 0)).toBeNull();
    const disabled = gift("L", { rewardMaxQuantity: 0 });
    expect(toggleGiftSelection(new Set(["r2:bottle"]), disabled, [disabled], 1)).toBeNull();
  });
});

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
