import { and, eq } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";
import { decryptToken, encryptToken } from "./token-crypto.server.js";

export const SKIO_API_KEY_SETTING = "integration.skio.api_key";

export async function getSkioApiKey(db: Db, shopId: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, SKIO_API_KEY_SETTING)))
    .limit(1);
  return row ? decryptToken(row.value) : null;
}

export async function saveSkioApiKey(db: Db, shopId: string, apiKey: string): Promise<void> {
  const encrypted = await encryptToken(apiKey);
  await db.insert(appSettings)
    .values({ shopId, key: SKIO_API_KEY_SETTING, value: encrypted })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: encrypted, updatedAt: new Date() },
    });
}

export async function deleteSkioApiKey(db: Db, shopId: string): Promise<void> {
  await db.delete(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, SKIO_API_KEY_SETTING)));
}
