/**
 * Tests for the progress bar Web Component behavior.
 * These are unit tests for the interpolation and rendering logic.
 */

import { describe, it, expect } from "vitest";
import { interpolate } from "@promo/shared-types";

describe("interpolate", () => {
  it("replaces {{remaining_amount}}", () => {
    const result = interpolate("Spend {{remaining_amount}} more for a free gift!", {
      remaining_amount: "$25.00",
    });
    expect(result).toBe("Spend $25.00 more for a free gift!");
  });

  it("replaces multiple variables", () => {
    const result = interpolate("{{current_amount}} of {{target_amount}} spent", {
      current_amount: "$30.00",
      target_amount: "$50.00",
    });
    expect(result).toBe("$30.00 of $50.00 spent");
  });

  it("leaves unknown variables as-is", () => {
    const result = interpolate("Spend {{unknown_var}} more", {});
    expect(result).toBe("Spend {{unknown_var}} more");
  });

  it("handles empty template", () => {
    const result = interpolate("", { key: "value" });
    expect(result).toBe("");
  });
});
