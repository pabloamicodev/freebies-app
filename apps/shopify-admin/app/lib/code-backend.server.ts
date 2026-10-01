/**
 * Which redemption backend a shop's code offers use.
 *  A (default): one Shopify code discount per offer, our codes attached as redeem codes.
 *  B: our own codes accepted by the code Function (needs live checkout verification before
 *     enabling). Controlled by the per-shop app setting "code_backend_b.enabled".
 */
import { appSettings, getDb } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const CODE_BACKEND_B_SETTING = "code_backend_b.enabled";

export async function isCodeBackendBEnabled(shopId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, CODE_BACKEND_B_SETTING)))
    .limit(1);
  if (!row) return false;
  try {
    return JSON.parse(row.value) === true;
  } catch {
    return false;
  }
}

export async function setCodeBackendB(shopId: string, enabled: boolean): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: CODE_BACKEND_B_SETTING, value: JSON.stringify(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: JSON.stringify(enabled), updatedAt: new Date() },
    });
}
