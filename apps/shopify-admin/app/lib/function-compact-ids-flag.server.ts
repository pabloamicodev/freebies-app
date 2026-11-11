import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const FUNCTION_COMPACT_IDS_SETTING = "function_compact_ids.enabled";

/**
 * FIX-cap-10 per-shop flag. Env FUNCTION_COMPACT_IDS=off forces it off everywhere; otherwise only an
 * explicit "true" row turns it on (default off, until the Functions that read numeric ids are deployed).
 */
export async function isFunctionCompactIdsEnabled(db: Db, shopId: string): Promise<boolean> {
  if (process.env["FUNCTION_COMPACT_IDS"] === "off") return false;
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, FUNCTION_COMPACT_IDS_SETTING)));
  return row?.value === "true";
}

export async function setFunctionCompactIdsEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: FUNCTION_COMPACT_IDS_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}
