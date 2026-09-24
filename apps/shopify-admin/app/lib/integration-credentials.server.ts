import { and, eq, inArray } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";
import { decryptToken, encryptToken, isEncryptedToken } from "./token-crypto.server.js";

export const INTEGRATION_IDS = [
  "klaviyo",
  "omnisend",
  "attentive",
  "rebuy",
  "gorgias",
  "postscript",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export function isIntegrationId(value: string): value is IntegrationId {
  return (INTEGRATION_IDS as readonly string[]).includes(value);
}

function settingKey(id: IntegrationId): string {
  return `integration.${id}.api_key`;
}

export async function listConnectedIntegrations(db: Db, shopId: string): Promise<IntegrationId[]> {
  const rows = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(and(
      eq(appSettings.shopId, shopId),
      inArray(appSettings.key, INTEGRATION_IDS.map(settingKey)),
    ));

  const keys = new Set(rows.map((row) => row.key));
  return INTEGRATION_IDS.filter((id) => keys.has(settingKey(id)));
}

export async function getIntegrationCredentials(
  db: Db,
  shopId: string,
): Promise<Map<IntegrationId, string>> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(and(
      eq(appSettings.shopId, shopId),
      inArray(appSettings.key, INTEGRATION_IDS.map(settingKey)),
    ));

  const credentials = new Map<IntegrationId, string>();
  for (const row of rows) {
    const id = INTEGRATION_IDS.find((candidate) => settingKey(candidate) === row.key);
    if (!id) continue;
    const plaintext = await decryptToken(row.value);
    credentials.set(id, plaintext);

    // Opportunistically migrate legacy plaintext credentials without exposing
    // them through loaders or requiring merchants to reconnect.
    if (!isEncryptedToken(row.value)) {
      await saveIntegrationCredential(db, shopId, id, plaintext);
    }
  }
  return credentials;
}

export async function saveIntegrationCredential(
  db: Db,
  shopId: string,
  id: IntegrationId,
  plaintext: string,
): Promise<void> {
  const encrypted = await encryptToken(plaintext);
  await db
    .insert(appSettings)
    .values({ shopId, key: settingKey(id), value: encrypted })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: encrypted, updatedAt: new Date() },
    });
}

export async function deleteIntegrationCredential(
  db: Db,
  shopId: string,
  id: IntegrationId,
): Promise<void> {
  await db
    .delete(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, settingKey(id))));
}
