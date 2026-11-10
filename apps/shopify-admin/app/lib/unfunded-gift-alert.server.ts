import * as Sentry from "@sentry/node";
import { checkRateLimit, envLimit } from "./rate-limit.server.js";

const HOUR_MS = 60 * 60 * 1000;
export const UNFUNDED_GIFT_REASON = "gift_not_discounted";
export const UNFUNDED_GIFT_EVENT = "promo_engine:gift_removed";

/**
 * Counts storefront removals of gifts Shopify left at full price, per shop per hour. Past the threshold (default 20)
 * it sends ONE Sentry warning per shop per hour: a burst usually means a Function outage or discount drift.
 * Counters are Redis fixed windows (per-instance memory if Redis is down); never throws.
 */
export async function recordUnfundedGiftRemovals(shopId: string, shopDomain: string, count: number): Promise<void> {
  try {
    const threshold = envLimit("UNFUNDED_GIFT_ALERT_PER_HOUR", 20);
    let over = false;
    for (let i = 0; i < Math.min(count, 50); i += 1) {
      const result = await checkRateLimit(`unfunded-gift:${shopId}`, { limit: threshold, windowMs: HOUR_MS, fixedWindow: true, onRedisUnavailable: "memory" });
      if (!result.ok) over = true;
    }
    if (!over) return;
    const first = await checkRateLimit(`unfunded-gift-alert:${shopId}`, { limit: 1, windowMs: HOUR_MS, fixedWindow: true, onRedisUnavailable: "memory" });
    if (!first.ok) return;
    console.warn(JSON.stringify({ level: "warn", msg: "Gifts removed because Shopify did not discount them", shopDomain, threshold, reason: UNFUNDED_GIFT_REASON }));
    Sentry.captureMessage("Gifts removed because Shopify did not discount them", {
      level: "warning",
      tags: { shop: shopDomain, reason: UNFUNDED_GIFT_REASON },
      extra: { threshold, windowMinutes: 60 },
    });
  } catch (error) {
    console.warn("unfunded gift alert counter failed", error);
  }
}

/** Number of gift_not_discounted removal events in an analytics batch. */
export function countUnfundedGiftRemovals(events: Array<Record<string, unknown>>, names: string[]): number {
  return events.filter((event, index) => {
    const nested = event["properties"];
    const reason = event["reason"] ?? (typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>)["reason"] : undefined);
    return names[index] === UNFUNDED_GIFT_EVENT && reason === UNFUNDED_GIFT_REASON;
  }).length;
}
