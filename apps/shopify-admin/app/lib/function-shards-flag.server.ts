import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const FUNCTION_SHARDS_SETTING = "function_shards.enabled";

export async function isFunctionShardsEnabled(db: Db, shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, FUNCTION_SHARDS_SETTING)));
  // Default ON since 2026-11-10: only an explicit "false" keeps a shop on one node (kill-switch).
  return row?.value !== "false";
}

export async function setFunctionShardsEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: FUNCTION_SHARDS_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}
