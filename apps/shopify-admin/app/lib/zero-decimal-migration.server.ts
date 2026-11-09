import { and, eq, lt } from "drizzle-orm";
import { appSettings, offerConditions, offerRewards, shops, type Db } from "@promo/db";
import { isZeroDecimalCurrency } from "./money.js";

/**
 * One-off: before the unit fix, zero-decimal shops (JPY, KRW, ...) saved every threshold x100 (5000 yen as 500000), but the
 * Functions and the rule engine now read whole units. This rewrites those rows once. Only rows last updated before `before`
 * are read, and every write stamps updated_at with now, so a second run (or a row saved after the fix) is skipped.
 */
export interface ZeroDecimalMigrationOptions {
  /** Rows updated at or after this instant are already in whole units. Must not be in the future. */
  before: Date;
  apply: boolean;
  /** myshopify domains; every zero-decimal shop when empty. */
  shopDomains?: string[];
  now?: Date;
  /** A shop already migrated is refused (a later cutoff would divide it again) unless this is set. */
  allowRerun?: boolean;
}

/** app_settings key written, in the same transaction as the rows, for each migrated shop. */
export const MIGRATION_MARKER_KEY = "migrations.zero_decimal_thresholds";

export interface ThresholdChange {
  shop: string;
  table: "offer_conditions" | "offer_rewards";
  id: string;
  offerId: string;
  field: string;
  from: number | string;
  to: number | string;
}

export interface ZeroDecimalMigrationResult {
  shopsScanned: number;
  changes: ThresholdChange[];
  skipped: Array<{ shop: string; table: string; id: string; reason: string }>;
  /** Shops left alone because an earlier --apply already migrated them. */
  alreadyMigrated: string[];
  rowsWritten: number;
}

type Json = Record<string, unknown>;
const isLegacy = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value % 100 === 0;
const isNumber = (value: unknown): value is number => typeof value === "number";

/** Pure: the value with its x100 thresholds divided, or why the row was left alone. */
export function migrateConditionValue(conditionType: string, value: Json, shopCurrency: string): { value: Json; fields: Array<[string, number | string, number | string]> } | { skip: string } | null {
  const next: Json = { ...value };
  const fields: Array<[string, number | string, number | string]> = [];
  const divide = (container: Json, key: string, label: string): string | null => {
    const raw = container[key];
    if (raw === undefined || raw === null || raw === 0) return null;
    if (!isLegacy(raw)) return `${label} ${String(raw)} is not a multiple of 100`;
    container[key] = raw / 100;
    fields.push([label, raw, raw / 100]);
    return null;
  };

  if (conditionType === "cart_value" || conditionType === "cart_value_multiplier") {
    for (const key of ["thresholdCents", "maxCents", "maxAmountCents"]) {
      const problem = divide(next, key, key);
      if (problem) return { skip: problem };
    }
    // Overrides are in the market currency's own unit: only zero-decimal market currencies were wrongly x100.
    for (const key of ["currencyOverrides", "maxCurrencyOverrides"]) {
      const map = value[key];
      if (!map || typeof map !== "object") continue;
      const copy: Json = { ...(map as Json) };
      for (const currency of Object.keys(copy)) {
        if (!isZeroDecimalCurrency(currency)) continue;
        const problem = divide(copy, currency, `${key}.${currency}`);
        if (problem) return { skip: problem };
      }
      next[key] = copy;
    }
    // The Functions ignore the tag, but the rule engine sizes the unit by it: a zero-decimal shop's amounts are in its own currency.
    if (fields.length > 0 && typeof value["currencyCode"] === "string" && String(value["currencyCode"]).toUpperCase() !== shopCurrency.toUpperCase()) {
      fields.push(["currencyCode", String(value["currencyCode"]), shopCurrency.toUpperCase()]);
      next["currencyCode"] = shopCurrency.toUpperCase();
    } else if (fields.length > 0 && value["currencyCode"] === undefined) {
      next["currencyCode"] = shopCurrency.toUpperCase();
    }
  } else if (conditionType === "order_history_total_spent" || conditionType === "order_history_last_order_spent") {
    const problem = divide(next, "valueCents", "valueCents");
    if (problem) return { skip: problem };
  } else {
    return null;
  }
  return fields.length > 0 ? { value: next, fields } : null;
}

/** Pure: the reward's migrated tier column and subtotal tiers, or why it was left alone. */
export function migrateReward(reward: { rewardType: string; value: unknown; minCartSubtotalCents: number | null }):
  | { minCartSubtotalCents?: number; value?: Json; fields: Array<[string, number | string, number | string]> }
  | { skip: string }
  | null {
  const fields: Array<[string, number | string, number | string]> = [];
  const out: { minCartSubtotalCents?: number; value?: Json } = {};
  if (reward.rewardType === "product_gift" && reward.minCartSubtotalCents !== null && reward.minCartSubtotalCents !== 0) {
    if (!isLegacy(reward.minCartSubtotalCents)) return { skip: `minCartSubtotalCents ${reward.minCartSubtotalCents} is not a multiple of 100` };
    out.minCartSubtotalCents = reward.minCartSubtotalCents / 100;
    fields.push(["minCartSubtotalCents", reward.minCartSubtotalCents, out.minCartSubtotalCents]);
  }
  const value = reward.value as Json | null;
  if ((reward.rewardType === "shipping_discount" || reward.rewardType === "order_discount") && value && Array.isArray(value["tiers"])) {
    const tiers = (value["tiers"] as unknown[]).map((tier, index) => {
      if (!tier || typeof tier !== "object") return tier;
      const copy: Json = { ...(tier as Json) };
      for (const key of ["minimumSubtotalCents", "maximumSubtotalCents"]) {
        const raw = copy[key];
        if (raw === undefined || raw === null || raw === 0) continue;
        if (!isLegacy(raw)) throw new Error(`tiers[${index}].${key} ${isNumber(raw) ? raw : "?"} is not a multiple of 100`);
        copy[key] = raw / 100;
        fields.push([`tiers[${index}].${key}`, raw, raw / 100]);
      }
      return copy;
    });
    out.value = { ...value, tiers };
  }
  return fields.length > 0 ? { ...out, fields } : null;
}

export async function migrateZeroDecimalThresholds(db: Db, options: ZeroDecimalMigrationOptions): Promise<ZeroDecimalMigrationResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(options.before.getTime()) || options.before.getTime() > now.getTime()) {
    throw new Error("--before must be a past ISO timestamp: rows saved at or after it are already in whole units");
  }
  const allShops = await db.select({ id: shops.id, domain: shops.myshopifyDomain, currencyCode: shops.currencyCode }).from(shops);
  const targets = allShops.filter(
    (shop) => isZeroDecimalCurrency(shop.currencyCode) && (!options.shopDomains?.length || options.shopDomains.includes(shop.domain)),
  );
  const result: ZeroDecimalMigrationResult = { shopsScanned: targets.length, changes: [], skipped: [], alreadyMigrated: [], rowsWritten: 0 };

  const marked = new Set(
    (await db.select({ shopId: appSettings.shopId }).from(appSettings).where(eq(appSettings.key, MIGRATION_MARKER_KEY))).map((row) => row.shopId),
  );

  for (const shop of targets) {
    if (marked.has(shop.id) && !options.allowRerun) {
      result.alreadyMigrated.push(shop.domain);
      continue;
    }
    const currency = shop.currencyCode!;
    const conditions = await db
      .select({ id: offerConditions.id, offerId: offerConditions.offerId, conditionType: offerConditions.conditionType, value: offerConditions.value })
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shop.id), lt(offerConditions.updatedAt, options.before)));
    const rewards = await db
      .select({ id: offerRewards.id, offerId: offerRewards.offerId, rewardType: offerRewards.rewardType, value: offerRewards.value, min: offerRewards.minCartSubtotalCents })
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shop.id), lt(offerRewards.updatedAt, options.before)));

    const writes: Array<(executor: Pick<Db, "update">) => Promise<unknown>> = [];
    const record = (table: ThresholdChange["table"], id: string, offerId: string, fields: Array<[string, number | string, number | string]>) =>
      fields.forEach(([field, from, to]) => result.changes.push({ shop: shop.domain, table, id, offerId, field, from, to }));

    for (const condition of conditions) {
      const migrated = migrateConditionValue(condition.conditionType, (condition.value ?? {}) as Json, currency);
      if (!migrated) continue;
      if ("skip" in migrated) {
        result.skipped.push({ shop: shop.domain, table: "offer_conditions", id: condition.id, reason: migrated.skip });
        continue;
      }
      record("offer_conditions", condition.id, condition.offerId, migrated.fields);
      writes.push((executor) => executor.update(offerConditions).set({ value: migrated.value, updatedAt: now }).where(and(eq(offerConditions.shopId, shop.id), eq(offerConditions.id, condition.id))));
    }
    for (const reward of rewards) {
      let migrated: ReturnType<typeof migrateReward>;
      try {
        migrated = migrateReward({ rewardType: reward.rewardType, value: reward.value, minCartSubtotalCents: reward.min });
      } catch (error) {
        result.skipped.push({ shop: shop.domain, table: "offer_rewards", id: reward.id, reason: (error as Error).message });
        continue;
      }
      if (!migrated) continue;
      if ("skip" in migrated) {
        result.skipped.push({ shop: shop.domain, table: "offer_rewards", id: reward.id, reason: migrated.skip });
        continue;
      }
      record("offer_rewards", reward.id, reward.offerId, migrated.fields);
      const { fields: _fields, ...set } = migrated;
      writes.push((executor) => executor.update(offerRewards).set({ ...set, updatedAt: now }).where(and(eq(offerRewards.shopId, shop.id), eq(offerRewards.id, reward.id))));
    }

    if (options.apply) {
      const value = JSON.stringify({ at: now.toISOString(), before: options.before.toISOString(), rows: writes.length });
      await db.transaction(async (tx) => {
        for (const write of writes) await write(tx);
        await tx
          .insert(appSettings)
          .values({ shopId: shop.id, key: MIGRATION_MARKER_KEY, value })
          .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: now } });
      });
      result.rowsWritten += writes.length;
    }
  }
  return result;
}
