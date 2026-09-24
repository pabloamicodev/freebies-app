import { describe, expect, it } from "vitest";
import { withPromoMetadata } from "./metadata-bridge.js";

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
});
