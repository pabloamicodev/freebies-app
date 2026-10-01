import { describe, expect, it, vi } from "vitest";
import type { GiftSliderPayload } from "../types.js";
import {
  decideAutoOpen,
  fetchSoldOutVariantIds,
  friendlyGiftError,
  GiftSliderError,
  GiftSoldOutError,
  isSoldOutCartError,
  soldOutVariantIdsFromError,
} from "./gift-slider.js";

const soldOut422 = (name: string) =>
  new Error(
    `Cart API error 422: ${JSON.stringify({
      status: 422,
      message: `The product '${name}' is already sold out.`,
      description: `The product '${name}' is already sold out.`,
    })}`,
  );

describe("friendlyGiftError", () => {
  it("replaces a raw Cart API 'already sold out' dump with a short customer-facing message", () => {
    expect(friendlyGiftError(soldOut422("Ambrosia Athletic Club T-Shirt - M"), "fallback")).toBe(
      "That size just sold out — pick another.",
    );
  });

  it("falls back to a generic message for a raw Cart API error that isn't a stock issue", () => {
    const raw = new Error(`Cart API error 500: ${JSON.stringify({ status: 500, message: "Internal error" })}`);
    expect(friendlyGiftError(raw, "generic fallback")).toBe("generic fallback");
  });

  it("falls back to a generic message when the raw Cart API error body isn't JSON", () => {
    expect(friendlyGiftError(new Error("Cart API error 422: not json"), "generic fallback")).toBe("generic fallback");
  });

  it("never shows arbitrary Error text (network errors, Storefront API userErrors)", () => {
    expect(friendlyGiftError(new TypeError("Failed to fetch"), "fallback")).toBe("fallback");
    expect(friendlyGiftError(new Error("cartLinesAdd: Merchandise is invalid"), "fallback")).toBe("fallback");
  });

  it("maps a Storefront API stock userError to the sold-out message", () => {
    expect(
      friendlyGiftError(new Error("cartLinesAdd: The product 'Tee - L' is already sold out."), "fallback"),
    ).toBe("That size just sold out — pick another.");
  });

  it("passes through our own customer-facing GiftSliderError messages", () => {
    expect(friendlyGiftError(new GiftSliderError("Too many gifts were selected for this offer."), "fallback")).toBe(
      "Too many gifts were selected for this offer.",
    );
    expect(friendlyGiftError(new GiftSoldOutError(["v1"], "Please choose again."), "fallback")).toBe(
      "Please choose again.",
    );
  });

  it("falls back for non-Error values", () => {
    expect(friendlyGiftError("boom", "fallback")).toBe("fallback");
  });
});

describe("isSoldOutCartError", () => {
  it("detects the raw 422 sold-out shape and our own GiftSoldOutError", () => {
    expect(isSoldOutCartError(soldOut422("Tee - M"))).toBe(true);
    expect(isSoldOutCartError(new GiftSoldOutError([]))).toBe(true);
    expect(isSoldOutCartError(new Error("Cart API error 500: {}"))).toBe(false);
  });
});

describe("soldOutVariantIdsFromError", () => {
  const gifts = [
    { variantId: "gid://shopify/ProductVariant/1", title: "Ambrosia Athletic Club T-Shirt", variantTitle: "L" },
    { variantId: "gid://shopify/ProductVariant/2", title: "Ambrosia Athletic Club T-Shirt", variantTitle: "M" },
  ];

  it("blames the only attempted gift", () => {
    expect(soldOutVariantIdsFromError(soldOut422("anything"), [gifts[0]!])).toEqual([gifts[0]!.variantId]);
  });

  it("matches the product - variant name Shopify quotes in the message", () => {
    expect(soldOutVariantIdsFromError(soldOut422("Ambrosia Athletic Club T-Shirt - M"), gifts)).toEqual([
      "gid://shopify/ProductVariant/2",
    ]);
  });

  it("returns nothing when the message names none of the attempted gifts", () => {
    expect(soldOutVariantIdsFromError(soldOut422("Other - S"), gifts)).toEqual([]);
  });
});

describe("fetchSoldOutVariantIds", () => {
  const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

  it("flags variants the storefront product JSON reports unavailable, one request per handle", async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      json({ variants: [{ id: 1, available: true }, { id: 2, available: false }] }),
    );
    const result = await fetchSoldOutVariantIds(
      [
        { variantId: "gid://shopify/ProductVariant/1", productHandle: "tee" },
        { variantId: "gid://shopify/ProductVariant/2", productHandle: "tee" },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    expect([...result]).toEqual(["gid://shopify/ProductVariant/2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/products/tee.js");
  });

  it("leaves stock unknown on missing handle, 404 or network error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(null, false))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await fetchSoldOutVariantIds(
      [
        { variantId: "gid://shopify/ProductVariant/1", productHandle: null },
        { variantId: "gid://shopify/ProductVariant/2", productHandle: "hidden" },
        { variantId: "gid://shopify/ProductVariant/3", productHandle: "offline" },
      ],
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("decideAutoOpen", () => {
  const slider = (offerId = "o1", over: Partial<GiftSliderPayload> = {}, avail = true): GiftSliderPayload =>
    ({
      offerId,
      alreadySelectedCount: 0,
      selectableGifts: [{ rewardId: `r-${offerId}`, offerVersion: 3, isAvailable: avail }],
      ...over,
    }) as unknown as GiftSliderPayload;
  const none = new Set<string>();
  const q = (...ids: string[]) => new Set(ids);
  const ids = (r: { open: GiftSliderPayload[] }) => r.open.map((s) => s.offerId);

  it("opens on first qualification, not again while still qualified (dismiss / re-render)", () => {
    const first = decideAutoOpen(none, [slider()], q("o1"), none);
    expect(ids(first)).toEqual(["o1"]);
    expect(ids(decideAutoOpen(first.keys, [slider()], q("o1"), new Set(["o1:r-o1"])))).toEqual([]);
    expect(ids(decideAutoOpen(first.keys, [slider()], q("o1"), none))).toEqual([]);
  });

  it("reopens after dipping below the threshold and crossing again, even for an identical cart", () => {
    const first = decideAutoOpen(none, [slider()], q("o1"), none);
    const dipped = decideAutoOpen(first.keys, [], q(), none);
    expect(dipped.keys.size).toBe(0);
    expect(ids(decideAutoOpen(dipped.keys, [slider()], q("o1"), none))).toEqual(["o1"]);
  });

  it("reload keeps the persisted stretch (no reopen) until a real down-up transition", () => {
    const persisted = decideAutoOpen(none, [slider()], q("o1"), none).keys;
    expect(ids(decideAutoOpen(new Set(persisted), [slider()], q("o1"), none))).toEqual([]);
  });

  it("does not open when the gift is already in the cart, and stays quiet afterwards", () => {
    const r = decideAutoOpen(none, [slider("o1", { alreadySelectedCount: 1 })], q("o1"), none);
    expect(ids(r)).toEqual([]);
    expect(ids(decideAutoOpen(r.keys, [slider()], q("o1"), none))).toEqual([]);
  });

  it("does not force-open a dead modal, but opens once stock returns", () => {
    const r = decideAutoOpen(none, [slider("o1", {}, false)], q("o1"), none);
    expect(ids(r)).toEqual([]);
    expect(ids(decideAutoOpen(r.keys, [slider()], q("o1"), none))).toEqual(["o1"]);
  });

  it("opens two offers qualifying together in priority order, neither again in the same stretch", () => {
    const both = [slider("a"), slider("b")];
    const r = decideAutoOpen(none, both, q("a", "b"), none);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(ids(decideAutoOpen(r.keys, both, q("a", "b"), none))).toEqual([]);
  });

  it("tier 1 then tier 2 crossing in sequence opens each once", () => {
    const t1 = decideAutoOpen(none, [slider("t1")], q("t1"), none);
    expect(ids(t1)).toEqual(["t1"]);
    const t2 = decideAutoOpen(t1.keys, [slider("t1"), slider("t2")], q("t1", "t2"), none);
    expect(ids(t2)).toEqual(["t2"]);
  });

  it("dropping below tier 2 but staying above tier 1 reopens only tier 2 when crossed again", () => {
    const both = decideAutoOpen(none, [slider("t1"), slider("t2")], q("t1", "t2"), none);
    const dipped = decideAutoOpen(both.keys, [slider("t1")], q("t1"), none);
    expect(ids(dipped)).toEqual([]);
    const back = decideAutoOpen(dipped.keys, [slider("t1"), slider("t2")], q("t1", "t2"), none);
    expect(ids(back)).toEqual(["t2"]);
  });

  it("keeps state for offers that still qualify but have no visible slider", () => {
    const r = decideAutoOpen(none, [slider("a")], q("a"), none);
    const hidden = decideAutoOpen(r.keys, [], q("a"), none);
    expect(hidden.keys.size).toBe(1);
    expect(ids(decideAutoOpen(hidden.keys, [slider("a")], q("a"), none))).toEqual([]);
  });

  it("opens when the primary is out of stock but a fallback option comes back available", () => {
    const withFallback = slider("o1", {
      selectableGifts: [
        { rewardId: "r1", offerVersion: 3, isAvailable: true, replacesTitle: "T-Shirt" },
      ] as unknown as GiftSliderPayload["selectableGifts"],
    });
    expect(ids(decideAutoOpen(none, [withFallback], q("o1"), none))).toEqual(["o1"]);
    const mixed = slider("o1", {
      selectableGifts: [
        { rewardId: "r1", offerVersion: 3, isAvailable: false },
        { rewardId: "r2", offerVersion: 3, isAvailable: true },
      ] as unknown as GiftSliderPayload["selectableGifts"],
    });
    expect(ids(decideAutoOpen(none, [mixed], q("o1"), none))).toEqual(["o1"]);
  });
});
