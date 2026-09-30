import { describe, expect, it } from "vitest";
import { friendlyGiftError } from "./gift-slider.js";

describe("friendlyGiftError", () => {
  it("replaces a raw Cart API 'already sold out' dump with a short customer-facing message", () => {
    const raw = new Error(
      `Cart API error 422: ${JSON.stringify({
        status: 422,
        message: "The product 'Ambrosia Athletic Club T-Shirt - M' is already sold out.",
        description: "The product 'Ambrosia Athletic Club T-Shirt - M' is already sold out.",
      })}`,
    );
    expect(friendlyGiftError(raw, "fallback")).toBe("That size just sold out — pick another.");
  });

  it("falls back to a generic message for a raw Cart API error that isn't a stock issue", () => {
    const raw = new Error(`Cart API error 500: ${JSON.stringify({ status: 500, message: "Internal error" })}`);
    expect(friendlyGiftError(raw, "generic fallback")).toBe("generic fallback");
  });

  it("falls back to a generic message when the raw Cart API error body isn't JSON", () => {
    const raw = new Error("Cart API error 422: not json");
    expect(friendlyGiftError(raw, "generic fallback")).toBe("generic fallback");
  });

  it("passes through messages that are already customer-friendly (not the raw Cart API shape)", () => {
    const friendly = new Error("One of the selected gifts is no longer available. Please choose again.");
    expect(friendlyGiftError(friendly, "fallback")).toBe(
      "One of the selected gifts is no longer available. Please choose again.",
    );
  });

  it("falls back for non-Error values", () => {
    expect(friendlyGiftError("boom", "fallback")).toBe("fallback");
  });
});
