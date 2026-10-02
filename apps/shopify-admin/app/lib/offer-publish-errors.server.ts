/**
 * Per-offer problems a publish worked around instead of failing the shop: today, code-gated shipping
 * that could not be pushed to the coded-shipping pool. Stored per shop in `app_settings` as one map
 * (offerId -> merchant-facing message) that every publish replaces wholesale, so a fixed offer's
 * message disappears on the next publish. The admin reads it with `getOfferPublishErrors`.
 */
import { appSettings, getDb } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const OFFER_PUBLISH_ERRORS_SETTING = "offer_publish_errors.v1";

export type OfferPublishErrors = Record<string, string>;

export async function setOfferPublishErrors(shopId: string, errors: OfferPublishErrors): Promise<void> {
  const value = JSON.stringify(errors);
  await getDb()
    .insert(appSettings)
    .values({ shopId, key: OFFER_PUBLISH_ERRORS_SETTING, value })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function getOfferPublishErrors(shopId: string): Promise<OfferPublishErrors> {
  const [row] = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, OFFER_PUBLISH_ERRORS_SETTING)))
    .limit(1);
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
