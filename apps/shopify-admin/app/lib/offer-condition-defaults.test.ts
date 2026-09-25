import { describe, expect, it } from "vitest";
import { initializeOfferConditionValues } from "./offer-condition-defaults.js";

describe("initializeOfferConditionValues", () => {
  it("initializes newly selected cards and drops values for deselected cards", () => {
    const result = initializeOfferConditionValues(["link", "subscription"], {
      link: { requiredUrl: "/pages/vip", paramName: "code" },
      customer_tags: { includeTags: ["stale"] },
    });

    expect(result).toEqual({
      link: { requiredUrl: "/pages/vip", paramName: "code" },
      subscription: { mode: "subscription_only" },
    });
  });

  it("returns independent nested defaults across calls", () => {
    const first = initializeOfferConditionValues(["quantity_limit"], {});
    const second = initializeOfferConditionValues(["quantity_limit"], {});
    const firstRules = first.quantity_limit?.rules as Array<{ qty: number }>;
    firstRules[0]!.qty = 9;

    expect((second.quantity_limit?.rules as Array<{ qty: number }>)[0]!.qty).toBe(1);
  });
});
