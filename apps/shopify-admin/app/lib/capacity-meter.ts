import { SHOPIFY_AUTOMATIC_LIMIT } from "./capacity-copy.js";

export const METER_WARN_AT = 0.8;

export type LimitsLevel = "unknown" | "ok" | "warning" | "critical";

export interface LimitsMeter {
  limit: number;
  /** Active automatic discounts in the store, all apps; null when Shopify couldn't say. */
  storeActive: number | null;
  /** Of those, Promo Engine's own. */
  ours: number;
  others: number | null;
  /** Cart slots (Shopify discounts) Promo Engine's offers occupy / may occupy. */
  slotsInUse: number;
  maxCartSlots: number;
  shardsEnabled: boolean;
  level: LimitsLevel;
  discountsUrl?: string;
}

export function limitsLevel(storeActive: number | null): LimitsLevel {
  if (storeActive === null) return "unknown";
  if (storeActive >= SHOPIFY_AUTOMATIC_LIMIT) return "critical";
  return storeActive >= SHOPIFY_AUTOMATIC_LIMIT * METER_WARN_AT ? "warning" : "ok";
}

export function limitsBanner(meter: Pick<LimitsMeter, "level" | "storeActive" | "limit">): { title: string; body: string } | null {
  if (meter.level === "warning") {
    return {
      title: "Your store is close to Shopify's automatic discount limit",
      body: `Shopify allows ${meter.limit} active automatic discounts per store, including discounts from other apps. You're using ${meter.storeActive}. Promo Engine may need more as you add offers.`,
    };
  }
  if (meter.level === "critical") {
    return {
      title: "Shopify's automatic discount limit is reached",
      body: `Shopify allows ${meter.limit} active automatic discounts per store, including discounts from other apps. You're using ${meter.storeActive}. Deactivate an automatic discount you no longer use before adding more offers.`,
    };
  }
  return null;
}
