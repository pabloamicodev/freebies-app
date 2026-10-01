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
  const slider = (over: Partial<GiftSliderPayload> = {}, avail = true): GiftSliderPayload =>
    ({
      offerId: "o1",
      alreadySelectedCount: 0,
      selectableGifts: [{ rewardId: "r1", offerVersion: 3, isAvailable: avail }],
      ...over,
    }) as unknown as GiftSliderPayload;
  const none = new Set<string>();

  it("opens on first qualification, not again while still qualified (dismiss / re-render)", () => {
    const first = decideAutoOpen(none, slider(), none);
    expect(first.open).toBe(true);
    expect(decideAutoOpen(first.keys, slider(), new Set(["o1:r1"])).open).toBe(false);
    expect(decideAutoOpen(first.keys, slider(), none).open).toBe(false);
  });

  it("reopens after dipping below the threshold and crossing again, even for an identical cart", () => {
    const first = decideAutoOpen(none, slider(), none);
    const dipped = decideAutoOpen(first.keys, null, none);
    expect(dipped.keys.size).toBe(0);
    expect(decideAutoOpen(dipped.keys, slider(), none).open).toBe(true);
  });

  it("reload keeps the persisted stretch (no reopen) until a real down-up transition", () => {
    const persisted = decideAutoOpen(none, slider(), none).keys;
    expect(decideAutoOpen(new Set(persisted), slider(), none).open).toBe(false);
  });

  it("does not open when the gift is already in the cart, and stays quiet afterwards", () => {
    const r = decideAutoOpen(none, slider({ alreadySelectedCount: 1 }), none);
    expect(r.open).toBe(false);
    expect(decideAutoOpen(r.keys, slider(), none).open).toBe(false);
  });

  it("does not force-open a dead modal, but opens once stock returns", () => {
    const r = decideAutoOpen(none, slider({}, false), none);
    expect(r.open).toBe(false);
    expect(decideAutoOpen(r.keys, slider(), none).open).toBe(true);
  });

  it("drops other offers' state", () => {
    expect(decideAutoOpen(new Set(["o2:1"]), slider(), none).keys.has("o2:1")).toBe(false);
  });
});
