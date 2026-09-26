import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPromoMetadataBridge,
  needsPromoMetadataPacking,
  packCartAddRequest,
  withPromoMetadata,
} from "./metadata-bridge.js";

describe("withPromoMetadata", () => {
  it("stamps and packs the originating storefront URL for checkout enforcement", () => {
    const properties = withPromoMetadata({}, "/pages/vip?code=summer");
    expect(properties._promo_page_url).toBe("/pages/vip?code=summer");
    expect(JSON.parse(properties._promo_engine_metadata!)).toMatchObject({
      _promo_page_url: "/pages/vip?code=summer",
    });
  });

  it("packs legacy and current promotion properties into one Function field", () => {
    const properties = withPromoMetadata({
      _promo_engine_line_type: "gift",
      _promo_engine_offer_id: "offer-1",
      __landing_source: "protein-lp",
      unrelated: "preserved",
    });

    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({
      _promo_engine_line_type: "gift",
      _promo_engine_offer_id: "offer-1",
      __landing_source: "protein-lp",
      unrelated: "preserved",
    });
    expect(properties.unrelated).toBe("preserved");
  });

  it("merges existing metadata and refreshes direct values", () => {
    const properties = withPromoMetadata({
      _promo_engine_metadata: JSON.stringify({ _quiz_bundle_id: "old", custom: "keep" }),
      _quiz_bundle_id: "new",
    });

    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({
      _quiz_bundle_id: "new",
      custom: "keep",
    });
  });

  it("packs custom properties so Function conditions are not limited by query slots", () => {
    const properties = withPromoMetadata({ engraving: "Ada" });
    expect(JSON.parse(properties._promo_engine_metadata!)).toEqual({ engraving: "Ada" });
  });

  it("detects legacy promotional properties that still need packing", () => {
    expect(
      needsPromoMetadataPacking({
        _promo_engine_offer_id: "offer-legacy",
        _promo_engine_reward_id: "reward-legacy",
      }),
    ).toBe(true);
    expect(
      needsPromoMetadataPacking(
        withPromoMetadata({
          _promo_engine_offer_id: "offer-current",
        }),
      ),
    ).toBe(false);
    expect(needsPromoMetadataPacking({ engraving: "Ada" })).toBe(true);
  });
});

describe("packCartAddRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stamps URL metadata on ordinary JSON cart lines that have no properties", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://store.example", pathname: "/pages/vip", search: "?code=summer" },
    });
    const [input, init] = await packCartAddRequest("/cart/add.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: 123, quantity: 1 }] }),
    });

    expect(input).toBe("/cart/add.js");
    const payload = JSON.parse(String(init?.body)) as {
      items: Array<{ properties: Record<string, string> }>;
    };
    expect(payload.items[0]!.properties._promo_page_url).toBe("/pages/vip?code=summer");
    expect(JSON.parse(payload.items[0]!.properties._promo_engine_metadata!)).toMatchObject({
      _promo_page_url: "/pages/vip?code=summer",
    });
  });

  it("packs metadata from a Request body when fetch has no init argument", async () => {
    const request = new Request("https://store.example/cart/add.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: 123,
            quantity: 1,
            properties: { _promo_engine_offer_id: "offer-request" },
          },
        ],
      }),
    });

    const [packed] = await packCartAddRequest(request);
    expect(packed).toBeInstanceOf(Request);
    const payload = (await (packed as Request).json()) as {
      items: Array<{ properties: Record<string, string> }>;
    };
    expect(JSON.parse(payload.items[0]!.properties._promo_engine_metadata!)).toEqual({
      _promo_engine_offer_id: "offer-request",
    });
  });

  it("leaves non-cart requests untouched", async () => {
    const request = new Request("https://store.example/products.json");
    const [packed, init] = await packCartAddRequest(request);
    expect(packed).toBe(request);
    expect(init).toBeUndefined();
  });
});

describe("installPromoMetadataBridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the original request if metadata packing throws", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("window", {
      fetch: nativeFetch,
      location: { origin: "https://store.example", pathname: "/", search: "" },
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });

    installPromoMetadataBridge();

    // Content-type says multipart but the body isn't — formData() parsing rejects,
    // which used to propagate out of window.fetch instead of falling back.
    const badRequest = new Request("https://store.example/cart/add.js", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not actually multipart",
    });

    const response = await window.fetch(badRequest);
    expect(response).toBeInstanceOf(Response);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledWith(badRequest, undefined);
  });
});
