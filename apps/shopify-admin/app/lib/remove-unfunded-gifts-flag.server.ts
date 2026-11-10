import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const REMOVE_UNFUNDED_GIFTS_SETTING = "storefront.remove_unfunded_gifts";

/** Per-shop switch for the storefront runtime removing a gift Shopify left at full price. Default OFF. */
export async function isRemoveUnfundedGiftsEnabled(db: Db, shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, REMOVE_UNFUNDED_GIFTS_SETTING)));
  return row?.value === "true";
}

export async function setRemoveUnfundedGiftsEnabled(db: Db, shopId: string, enabled: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ shopId, key: REMOVE_UNFUNDED_GIFTS_SETTING, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
}
