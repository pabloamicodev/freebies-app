/**
 * Per-offer problems a publish worked around instead of failing the shop: today, code-gated shipping
 * that could not be pushed to the coded-shipping pool. Stored per shop in `app_settings` as one map
 * (offerId -> merchant-facing message) that every publish replaces wholesale, so a fixed offer's
 * message disappears on the next publish. The admin reads it with `getOfferPublishErrors`.
 */
import { appSettings, getDb, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

export const OFFER_PUBLISH_ERRORS_SETTING = "offer_publish_errors.v1";

export type OfferPublishErrors = Record<string, string>;

/** A publish failure caused by one specific offer's own data, as opposed to a shop-wide one. */
export class OfferPublishError extends Error {
  constructor(
    readonly offerId: string,
    message: string,
  ) {
    super(message);
    this.name = "OfferPublishError";
  }
}

export function offerCompileError(offer: { id: string; internalName: string }, error: unknown): OfferPublishError {
  const reason = error instanceof Error ? error.message : String(error);
  return new OfferPublishError(offer.id, `"${offer.internalName}" cannot be compiled: ${reason}`);
}

export async function setOfferPublishErrors(
  shopId: string,
  errors: OfferPublishErrors,
  db: Db = getDb(),
): Promise<void> {
  const value = JSON.stringify(errors);
  await db
    .insert(appSettings)
    .values({ shopId, key: OFFER_PUBLISH_ERRORS_SETTING, value })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value, updatedAt: new Date() },
    });
}

/** Adds a pending error to these offers; the next successful publish clears it. */
export async function addOfferPublishErrors(
  db: Db,
  shopId: string,
  offerIds: string[],
  message: string,
): Promise<void> {
  const errors = await getOfferPublishErrors(shopId, db);
  for (const offerId of offerIds) errors[offerId] = message;
  await setOfferPublishErrors(shopId, errors, db);
}

export async function getOfferPublishErrors(shopId: string, db: Db = getDb()): Promise<OfferPublishErrors> {
  const [row] = await db
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
