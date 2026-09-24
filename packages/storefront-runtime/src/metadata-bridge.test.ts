import { describe, expect, it } from "vitest";
import {
  needsPromoMetadataPacking,
  packCartAddRequest,
  withPromoMetadata,
} from "./metadata-bridge.js";

describe("withPromoMetadata", () => {
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

  it("does not add metadata when no promotion property exists", () => {
    expect(withPromoMetadata({ engraving: "Ada" })).toEqual({ engraving: "Ada" });
  });

  it("detects legacy promotional properties that still need packing", () => {
    expect(needsPromoMetadataPacking({
      _promo_engine_offer_id: "offer-legacy",
      _promo_engine_reward_id: "reward-legacy",
    })).toBe(true);
    expect(needsPromoMetadataPacking(withPromoMetadata({
      _promo_engine_offer_id: "offer-current",
    }))).toBe(false);
    expect(needsPromoMetadataPacking({ engraving: "Ada" })).toBe(false);
  });
});

describe("packCartAddRequest", () => {
  it("packs metadata from a Request body when fetch has no init argument", async () => {
    const request = new Request("https://store.example/cart/add.js", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{
          id: 123,
          quantity: 1,
          properties: { _promo_engine_offer_id: "offer-request" },
        }],
      }),
    });

    const [packed] = await packCartAddRequest(request);
    expect(packed).toBeInstanceOf(Request);
    const payload = await (packed as Request).json() as {
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
