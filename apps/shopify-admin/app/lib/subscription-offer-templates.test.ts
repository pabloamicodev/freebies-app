import { describe, expect, it } from "vitest";
import { resolveSubscriptionTemplate, SUBSCRIPTION_OFFER_TEMPLATES } from "./subscription-offer-templates.js";

describe("resolveSubscriptionTemplate", () => {
  it("resolves every catalog slug to its management list", () => {
    expect(resolveSubscriptionTemplate("cycle-pricing")?.manageTo).toBe("/app/subscription-pricing");
    expect(resolveSubscriptionTemplate("skio-shipping")?.manageTo).toBe("/app/skio-shipping");
    expect(new Set(SUBSCRIPTION_OFFER_TEMPLATES.map((template) => template.slug)).size).toBe(
      SUBSCRIPTION_OFFER_TEMPLATES.length,
    );
  });

  it("rejects unknown or missing slugs", () => {
    expect(resolveSubscriptionTemplate("tiered")).toBeNull();
    expect(resolveSubscriptionTemplate(undefined)).toBeNull();
  });
});
