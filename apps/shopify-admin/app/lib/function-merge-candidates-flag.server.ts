import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const FUNCTION_MERGE_CANDIDATES_SETTING = "function_config.merge_candidates";

/**
 * Per-shop opt-in for the Functions folding adjacent identical percentage candidates into one (`mergeCandidates` in the
 * node config). Default OFF everywhere: only an explicit "true" row turns it on, and env FUNCTION_MERGE_CANDIDATES=off
 * forces it off for every shop. Needs the Functions that read the field to be deployed first (older ones ignore it).
 */
export async function isFunctionMergeCandidatesEnabled(db: Db, shopId: string): Promise<boolean> {
  if (process.env["FUNCTION_MERGE_CANDIDATES"] === "off") return false;
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, FUNCTION_MERGE_CANDIDATES_SETTING)));
  return row?.value === "true";
}

export async function setFunctionMergeCandidatesEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: FUNCTION_MERGE_CANDIDATES_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}
