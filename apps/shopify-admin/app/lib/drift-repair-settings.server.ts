/**
 * Drift-repair kill switch. Repair re-activates automatic nodes a merchant switched off and republishes
 * code nodes (which reopens their end date), so during an emergency "deactivate the discount nodes"
 * (docs/RUNBOOK.md, kill switches) it would undo the switch within five minutes. Pausing keeps
 * detection and the Sentry signal but skips every repair.
 *
 *  - `DRIFT_REPAIR_DISABLED=true` (env, Vercel project): every shop.
 *  - app setting `drift_repair.paused` = true: one shop.
 */
import { appSettings, getDb } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const DRIFT_REPAIR_PAUSED_SETTING = "drift_repair.paused";

export function isDriftRepairGloballyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(true|1|yes|on)$/i.test((env.DRIFT_REPAIR_DISABLED ?? "").trim());
}

export async function isDriftRepairPausedForShop(shopId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, DRIFT_REPAIR_PAUSED_SETTING)))
    .limit(1);
  if (!row) return false;
  try {
    return JSON.parse(row.value) === true;
  } catch {
    return false;
  }
}

export async function setDriftRepairPaused(shopId: string, paused: boolean): Promise<void> {
  const value = JSON.stringify(paused);
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: DRIFT_REPAIR_PAUSED_SETTING, value })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value, updatedAt: new Date() },
    });
}
