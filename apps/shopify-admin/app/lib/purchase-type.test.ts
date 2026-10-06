import { describe, expect, it } from "vitest";
import { OrderDiscountTargetSchema } from "@promo/shared-types";
import { normalizeSubscriptionMode, parseSubscriptionMode, purchaseTypeLabel, purchaseTypesToMode, withSubscriptionMode } from "./purchase-type.js";
import { rewardSummary } from "./offer-summaries.js";

describe("purchase type", () => {
  it("maps the two checkboxes to the Function's subscriptionMode and back to a label", () => {
    expect(purchaseTypesToMode(true, true)).toBe("any");
    expect(purchaseTypesToMode(true, false)).toBe("one_time_only");
    expect(purchaseTypesToMode(false, true)).toBe("subscription_only");
    expect(purchaseTypeLabel("any")).toBe("One-time + subscriptions");
    expect(purchaseTypeLabel(undefined)).toBe("One-time + subscriptions");
    expect(purchaseTypeLabel("subscription_only")).toBe("Subscriptions only");
    expect(purchaseTypeLabel("one_time_only")).toBe("One-time purchases only");
  });

  it("reads the form field and ignores unknown values", () => {
    const data = new FormData();
    expect(parseSubscriptionMode(data)).toBe("any");
    data.set("subscriptionMode", "one_time_only");
    expect(parseSubscriptionMode(data)).toBe("one_time_only");
    expect(normalizeSubscriptionMode("nope")).toBe("any");
  });

  it("keeps 'any' implicit and round-trips a restriction through the target", () => {
    expect(withSubscriptionMode({ scope: "cart" }, "any")).toEqual({ scope: "cart" });
    const restricted = withSubscriptionMode({ scope: "cart" }, "subscription_only");
    expect(restricted).toEqual({ scope: "cart", subscriptionMode: "subscription_only" });
    expect(withSubscriptionMode(restricted, "any")).toEqual({ scope: "cart" });
    expect(OrderDiscountTargetSchema.safeParse(restricted).success).toBe(true);
  });

  it("shows the purchase type in reward summaries (not for gifts or shipping)", () => {
    const base = { discountType: "percentage", value: { amount: 20 } };
    expect(rewardSummary({ ...base, rewardType: "order_discount", target: { scope: "cart" } })).toBe("Order discount — 20% off · One-time + subscriptions");
    expect(rewardSummary({ ...base, rewardType: "order_discount", target: { scope: "cart", subscriptionMode: "one_time_only" } })).toBe(
      "Order discount — 20% off · One-time purchases only",
    );
    expect(rewardSummary({ ...base, rewardType: "order_discount" })).toBe("Order discount — 20% off");
  });
});
