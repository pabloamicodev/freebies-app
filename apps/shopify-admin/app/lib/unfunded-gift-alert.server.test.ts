import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn() }));
import * as Sentry from "@sentry/node";
import { resetMemoryRateLimits } from "./rate-limit.server.js";
import { countUnfundedGiftRemovals, recordUnfundedGiftRemovals } from "./unfunded-gift-alert.server.js";

beforeEach(() => {
  resetMemoryRateLimits();
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("UNFUNDED_GIFT_ALERT_PER_HOUR", "20");
});

describe("recordUnfundedGiftRemovals", () => {
  it("stays quiet up to the threshold, then sends one warning per shop per hour", async () => {
    await recordUnfundedGiftRemovals("s1", "a.myshopify.com", 20);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    await recordUnfundedGiftRemovals("s1", "a.myshopify.com", 1);
    await recordUnfundedGiftRemovals("s1", "a.myshopify.com", 5);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ level: "warning", tags: { shop: "a.myshopify.com", reason: "gift_not_discounted" } }));
  });

  it("counts shops independently", async () => {
    await recordUnfundedGiftRemovals("s1", "a.myshopify.com", 21);
    await recordUnfundedGiftRemovals("s2", "b.myshopify.com", 3);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("countUnfundedGiftRemovals", () => {
  it("counts only gift_removed events with reason gift_not_discounted (flat or nested)", () => {
    const events = [{ reason: "gift_not_discounted" }, { properties: { reason: "gift_not_discounted" } }, { reason: "quantity_correction" }, { reason: "gift_not_discounted" }];
    const names = ["promo_engine:gift_removed", "promo_engine:gift_removed", "promo_engine:gift_removed", "promo_engine:gift_added"];
    expect(countUnfundedGiftRemovals(events, names)).toBe(2);
  });
});
