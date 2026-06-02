/**
 * Feature flags and kill switches.
 * All flags are controlled via app_settings in PostgreSQL.
 * Can be toggled per shop without code deploy.
 *
 * Kill switches:
 * - storefront.runtime_enabled  → disable all storefront JS
 * - gift.auto_add_enabled       → disable auto-add gift mutations
 * - discount.function_enabled   → disable Shopify Function discount config
 * - analytics.enabled           → disable analytics event ingestion
 */

import { getDb, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";

type FlagKey =
  | "app.enabled"
  | "storefront.runtime_enabled"
  | "gift.auto_add_enabled"
  | "discount.function_enabled"
  | "analytics.enabled"
  | "shadow_mode.enabled"
  | "debug.enabled"
  | "headless.enabled";

const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  "app.enabled": true,
  "storefront.runtime_enabled": true,
  "gift.auto_add_enabled": true,
  "discount.function_enabled": true,
  "analytics.enabled": true,
  "shadow_mode.enabled": false,
  "debug.enabled": false,
  "headless.enabled": false,
};

/** Cache to avoid repeated DB lookups within the same request. */
const cache = new Map<string, boolean>();

export async function getFlag(shopId: string, flag: FlagKey): Promise<boolean> {
  const cacheKey = `${shopId}:${flag}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const db = getDb();
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, flag)))
    .limit(1);

  const value = rows[0]?.value;
  let parsed = FLAG_DEFAULTS[flag];
  if (value !== undefined) {
    try { parsed = JSON.parse(value) === true; } catch { parsed = value === "true"; }
  }

  cache.set(cacheKey, parsed);
  return parsed;
}

export async function setFlag(shopId: string, flag: FlagKey, value: boolean): Promise<void> {
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ shopId, key: flag, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(value), updatedAt: new Date() },
    });
  cache.delete(`${shopId}:${flag}`);
}

/** Check if the entire promo engine is enabled for a shop. */
export async function isAppEnabled(shopId: string): Promise<boolean> {
  return getFlag(shopId, "app.enabled");
}

/** Check if storefront runtime should inject JS. */
export async function isStorefrontEnabled(shopId: string): Promise<boolean> {
  return getFlag(shopId, "storefront.runtime_enabled");
}

/** Check if auto-add gift mutations should run. */
export async function isAutoAddEnabled(shopId: string): Promise<boolean> {
  return getFlag(shopId, "gift.auto_add_enabled");
}
