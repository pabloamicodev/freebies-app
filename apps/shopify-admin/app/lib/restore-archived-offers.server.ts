/**
 * Reinstall restore. app/uninstalled archives every active offer, so a merchant who reinstalls
 * finds an empty app. The uninstall records which offers it archived (as opposed to ones the
 * merchant archived themselves) and, after a reinstall, one click puts exactly those back and
 * republishes.
 */
import { and, eq, inArray } from "drizzle-orm";
import { appSettings, offers, type Db } from "@promo/db";
import { isConstraintViolation } from "./unique-offer-name.server.js";
import { activationStatus } from "./offer-scheduling.server.js";
import { publishShopConfig, validateOffersPublishable } from "./offer-publish-flow.server.js";

export const UNINSTALL_ARCHIVE_SETTING = "uninstall_archived_offers.v1";

interface UninstallArchiveRecord {
  archivedAt: string;
  offerIds: string[];
}

async function readRecord(db: Db, shopId: string): Promise<UninstallArchiveRecord | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, UNINSTALL_ARCHIVE_SETTING)))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as UninstallArchiveRecord;
    return Array.isArray(parsed?.offerIds) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRecord(db: Db, shopId: string, record: UninstallArchiveRecord | null): Promise<void> {
  if (!record || record.offerIds.length === 0) {
    await db
      .delete(appSettings)
      .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, UNINSTALL_ARCHIVE_SETTING)));
    return;
  }
  const value = JSON.stringify(record);
  await db
    .insert(appSettings)
    .values({ shopId, key: UNINSTALL_ARCHIVE_SETTING, value })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Called by the uninstall handler BEFORE it archives anything. A retried uninstall (nothing active
 * left to archive) leaves the record alone, so the list isn't overwritten with an empty one.
 */
export async function recordUninstallArchive(db: Db, shopId: string, offerIds: string[]): Promise<void> {
  if (offerIds.length === 0) return;
  const existing = await readRecord(db, shopId);
  await writeRecord(db, shopId, {
    archivedAt: new Date().toISOString(),
    offerIds: [...new Set([...(existing?.offerIds ?? []), ...offerIds])],
  });
}

async function stillArchived(db: Db, shopId: string, offerIds: string[]) {
  if (offerIds.length === 0) return [];
  const rows = await db
    .select({ id: offers.id, startsAt: offers.startsAt, endsAt: offers.endsAt })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), inArray(offers.id, offerIds), eq(offers.status, "archived")));
  return rows;
}

/** Offers archived by the uninstall that are still archived. 0 hides the banner. */
export async function getRestorableOffers(db: Db, shopId: string): Promise<{ count: number }> {
  const record = await readRecord(db, shopId);
  if (!record) return { count: 0 };
  return { count: (await stillArchived(db, shopId, record.offerIds)).length };
}

/** The merchant doesn't want them back: hides the banner without touching the offers. */
export async function dismissRestorableOffers(db: Db, shopId: string): Promise<void> {
  await writeRecord(db, shopId, null);
}

export interface RestoreDeps {
  publish?: (shopId: string, shopDomain: string) => Promise<string | null>;
  validate?: typeof validateOffersPublishable;
}

/**
 * Puts the uninstall-archived offers back to active and republishes. Offers that no longer
 * validate, or whose code is now held by another live offer, stay archived and are counted as
 * failed. If the publish itself fails, nothing is restored and the Shopify error is thrown.
 */
export async function restoreArchivedOffers(
  args: { db: Db; shopId: string; shopDomain: string },
  deps: RestoreDeps = {},
): Promise<{ restored: number; failed: number }> {
  const { db, shopId, shopDomain } = args;
  const publish = deps.publish ?? publishShopConfig;
  const validate = deps.validate ?? validateOffersPublishable;

  const record = await readRecord(db, shopId);
  if (!record) return { restored: 0, failed: 0 };
  const archived = await stillArchived(db, shopId, record.offerIds);
  const now = new Date();
  let failed = 0;
  const restoredIds: string[] = [];

  for (const { id: offerId, startsAt, endsAt } of archived) {
    const validation = await validate(db, shopId, [offerId]);
    if (!validation.ok) {
      failed += 1;
      continue;
    }
    try {
      await db
        .update(offers)
        .set({ status: activationStatus(startsAt, endsAt, now), archivedAt: null, updatedAt: now })
        .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId), eq(offers.status, "archived")));
      restoredIds.push(offerId);
    } catch (error) {
      // The partial unique index on required checkout codes: a live offer took the code meanwhile.
      if (!isConstraintViolation(error, "offers_shop_required_discount_code_idx")) throw error;
      failed += 1;
    }
  }

  if (restoredIds.length > 0) {
    const publishError = await publish(shopId, shopDomain);
    if (publishError) {
      await db
        .update(offers)
        .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(offers.shopId, shopId), inArray(offers.id, restoredIds)));
      await publish(shopId, shopDomain);
      throw new Error(publishError);
    }
  }

  await writeRecord(db, shopId, null);
  return { restored: restoredIds.length, failed };
}
