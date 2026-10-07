/**
 * Shadow mode — evaluates offers but does NOT apply cart mutations.
 * Used during migration: run promo engine evaluation in parallel with
 * BOGOS, compare results, and validate parity before cutover.
 *
 * Shadow mode is controlled by the app setting "shadow_mode.enabled".
 * When enabled:
 * - Evaluation runs normally and logs results to analytics_events
 * - Cart mutations (add gift, remove gift) are SKIPPED
 * - Discount Function is NOT active (no metafield config pushed)
 */

import { getDb, appSettings } from "@promo/db";
import { eq, and } from "drizzle-orm";
import { createMemoryCache } from "./memory-cache.server.js";
import { redisDelete, redisGetString, redisSetString } from "./redis.server.js";

// Read on every evaluate; cached 30s (D10) and dropped by setShadowMode.
const SHADOW_CACHE_TTL_SECONDS = 30;
const l1 = createMemoryCache<boolean>();
const cacheKey = (shopId: string) => `shadow:v1:${shopId}`;

export async function isShadowModeEnabled(shopId: string): Promise<boolean> {
  const hot = l1.get(cacheKey(shopId));
  if (hot !== undefined) return hot;
  const cached = await redisGetString(cacheKey(shopId));
  if (cached === "1" || cached === "0") {
    l1.set(cacheKey(shopId), cached === "1");
    return cached === "1";
  }
  const enabled = await readShadowMode(shopId);
  l1.set(cacheKey(shopId), enabled);
  await redisSetString(cacheKey(shopId), enabled ? "1" : "0", SHADOW_CACHE_TTL_SECONDS);
  return enabled;
}

async function readShadowMode(shopId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "shadow_mode.enabled")))
    .limit(1);

  if (!rows[0]) return false;
  try {
    return JSON.parse(rows[0].value) === true;
  } catch {
    return false;
  }
}

export async function setShadowMode(shopId: string, enabled: boolean): Promise<void> {
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ shopId, key: "shadow_mode.enabled", value: JSON.stringify(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(enabled), updatedAt: new Date() },
    });
  l1.delete(cacheKey(shopId));
  await redisDelete(cacheKey(shopId));
}
