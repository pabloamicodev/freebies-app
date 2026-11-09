import { and, eq, like, lt, or } from "drizzle-orm";
import { appSettings, offerConditions, offerRewards, shops, type Db } from "@promo/db";
import { isZeroDecimalCurrency } from "./money.js";

/**
 * One-off: before the unit fix, zero-decimal shops (JPY, KRW, ...) saved every threshold x100 (5000 yen as 500000), but the
 * Functions and the rule engine now read whole units. This rewrites those rows once. Only rows last updated before `before`
 * are read, and every write stamps updated_at with now, so a second run (or a row saved after the fix) is skipped.
 *
 * Two phases, each with its own per-shop marker: "thresholds" (cart values, tier subtotals, spend amounts) and "amounts"
 * (fixed discount values and the multicurrency fixed-amount overrides). A shop marked by the thresholds-only version still
 * gets the amounts phase. Rows that version rewrote carry its run time as updated_at, so the amounts phase also reads
 * rows stamped exactly then (their amounts were never touched).
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
/** Same, for the amounts phase; a shop carrying only the thresholds marker has not had it. */
export const AMOUNTS_MARKER_KEY = "migrations.zero_decimal_amounts";

interface Phases {
  thresholds: boolean;
  amounts: boolean;
}
const BOTH: Phases = { thresholds: true, amounts: true };

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
  /** Shops left alone because an earlier --apply already migrated them (both phases). */
  alreadyMigrated: string[];
  /** Shops that only had the thresholds phase done before, and got the amounts phase now (or would on --apply). */
  amountsOnly: string[];
  rowsWritten: number;
}

type Json = Record<string, unknown>;
const isLegacy = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value % 100 === 0;
const isNumber = (value: unknown): value is number => typeof value === "number";
const FIXED_AMOUNT_REWARDS = new Set(["product_discount", "bundle_discount", "upsell_discount", "order_discount", "product_gift"]);

/** Pure: the value with its x100 thresholds divided, or why the row was left alone. */
export function migrateConditionValue(conditionType: string, value: Json, shopCurrency: string, phases: Phases = BOTH): { value: Json; fields: Array<[string, number | string, number | string]> } | { skip: string } | null {
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
    const amounts = phases.amounts && conditionType === "cart_value";
    if (!phases.thresholds && !amounts) return null;
    for (const key of phases.thresholds ? ["thresholdCents", "maxCents", "maxAmountCents"] : []) {
      const problem = divide(next, key, key);
      if (problem) return { skip: problem };
    }
    // Overrides are in the market currency's own unit: only zero-decimal market currencies were wrongly x100.
    for (const key of [...(phases.thresholds ? ["currencyOverrides", "maxCurrencyOverrides"] : []), ...(amounts ? ["fixedAmountOverrides"] : [])]) {
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
    const retag = fields.some(([label]) => !label.startsWith("fixedAmountOverrides"));
    if (retag && typeof value["currencyCode"] === "string" && String(value["currencyCode"]).toUpperCase() !== shopCurrency.toUpperCase()) {
      fields.push(["currencyCode", String(value["currencyCode"]), shopCurrency.toUpperCase()]);
      next["currencyCode"] = shopCurrency.toUpperCase();
    } else if (retag && value["currencyCode"] === undefined) {
      next["currencyCode"] = shopCurrency.toUpperCase();
    }
  } else if (conditionType === "order_history_total_spent" || conditionType === "order_history_last_order_spent") {
    if (!phases.thresholds) return null;
    const problem = divide(next, "valueCents", "valueCents");
    if (problem) return { skip: problem };
  } else {
    return null;
  }
  return fields.length > 0 ? { value: next, fields } : null;
}

/** Pure: the reward's migrated tier column and subtotal tiers, or why it was left alone. */
export function migrateReward(reward: { rewardType: string; value: unknown; minCartSubtotalCents: number | null; discountType?: string }, phases: Phases = BOTH):
  | { minCartSubtotalCents?: number; value?: Json; fields: Array<[string, number | string, number | string]> }
  | { skip: string }
  | null {
  const fields: Array<[string, number | string, number | string]> = [];
  const out: { minCartSubtotalCents?: number; value?: Json } = {};
  if (phases.thresholds && reward.rewardType === "product_gift" && reward.minCartSubtotalCents !== null && reward.minCartSubtotalCents !== 0) {
    if (!isLegacy(reward.minCartSubtotalCents)) return { skip: `minCartSubtotalCents ${reward.minCartSubtotalCents} is not a multiple of 100` };
    out.minCartSubtotalCents = reward.minCartSubtotalCents / 100;
    fields.push(["minCartSubtotalCents", reward.minCartSubtotalCents, out.minCartSubtotalCents]);
  }
  const value = reward.value as Json | null;
  // Fixed amounts and fixed prices were saved x100; shipping rewards keep whole units for every currency, quantity tiers too.
  if (phases.amounts && FIXED_AMOUNT_REWARDS.has(reward.rewardType) && (reward.discountType === "fixed_amount" || reward.discountType === "fixed_price") && value) {
    const raw = value["amount"];
    if (raw !== undefined && raw !== null && raw !== 0) {
      if (!isLegacy(raw)) return { skip: `amount ${String(raw)} is not a multiple of 100` };
      out.value = { ...value, amount: raw / 100 };
      fields.push(["amount", raw, raw / 100]);
    }
  }
  if (phases.thresholds && (reward.rewardType === "shipping_discount" || reward.rewardType === "order_discount") && value && Array.isArray(value["tiers"])) {
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
    out.value = { ...(out.value ?? value), tiers };
  }
  return fields.length > 0 ? { ...out, fields } : null;
}

/** The run time recorded in a thresholds marker (epoch ms), or null when the value is not the JSON this module writes. */
function stampOf(markerValue: string | undefined): number | null {
  if (markerValue === undefined) return null;
  try {
    const at = Date.parse(String((JSON.parse(markerValue) as { at?: unknown }).at));
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
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
  const result: ZeroDecimalMigrationResult = { shopsScanned: targets.length, changes: [], skipped: [], alreadyMigrated: [], amountsOnly: [], rowsWritten: 0 };

  const markers = await db
    .select({ shopId: appSettings.shopId, key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(or(eq(appSettings.key, MIGRATION_MARKER_KEY), eq(appSettings.key, AMOUNTS_MARKER_KEY)));
  const thresholdsMarker = new Map(markers.filter((row) => row.key === MIGRATION_MARKER_KEY).map((row) => [row.shopId, row.value]));
  const amountsMarked = new Set(markers.filter((row) => row.key === AMOUNTS_MARKER_KEY).map((row) => row.shopId));

  for (const shop of targets) {
    const phases: Phases = {
      thresholds: options.allowRerun === true || !thresholdsMarker.has(shop.id),
      amounts: options.allowRerun === true || !amountsMarked.has(shop.id),
    };
    if (!phases.thresholds && !phases.amounts) {
      result.alreadyMigrated.push(shop.domain);
      continue;
    }
    if (!phases.thresholds) result.amountsOnly.push(shop.domain);
    // The thresholds-only version stamped the rows it rewrote with its run time; their amounts were never touched.
    // Only while the amounts phase has never run: after it, rows stamped at that time already hold whole amounts.
    const earlierRun = phases.amounts && !amountsMarked.has(shop.id) ? stampOf(thresholdsMarker.get(shop.id)) : null;
    const eligible = (updatedAt: Date) => ({
      thresholds: phases.thresholds && updatedAt < options.before,
      amounts: phases.amounts && (updatedAt < options.before || updatedAt.getTime() === earlierRun),
    });
    const currency = shop.currencyCode!;
    const conditions = await db
      .select({ id: offerConditions.id, offerId: offerConditions.offerId, conditionType: offerConditions.conditionType, value: offerConditions.value, updatedAt: offerConditions.updatedAt })
      .from(offerConditions)
      .where(and(eq(offerConditions.shopId, shop.id), earlierRun === null ? lt(offerConditions.updatedAt, options.before) : or(lt(offerConditions.updatedAt, options.before), eq(offerConditions.updatedAt, new Date(earlierRun)))));
    const rewards = await db
      .select({ id: offerRewards.id, offerId: offerRewards.offerId, rewardType: offerRewards.rewardType, discountType: offerRewards.discountType, value: offerRewards.value, min: offerRewards.minCartSubtotalCents, updatedAt: offerRewards.updatedAt })
      .from(offerRewards)
      .where(and(eq(offerRewards.shopId, shop.id), earlierRun === null ? lt(offerRewards.updatedAt, options.before) : or(lt(offerRewards.updatedAt, options.before), eq(offerRewards.updatedAt, new Date(earlierRun)))));

    const writes: Array<(executor: Pick<Db, "update">) => Promise<unknown>> = [];
    const record = (table: ThresholdChange["table"], id: string, offerId: string, fields: Array<[string, number | string, number | string]>) =>
      fields.forEach(([field, from, to]) => result.changes.push({ shop: shop.domain, table, id, offerId, field, from, to }));

    for (const condition of conditions) {
      const migrated = migrateConditionValue(condition.conditionType, (condition.value ?? {}) as Json, currency, eligible(condition.updatedAt));
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
        migrated = migrateReward({ rewardType: reward.rewardType, discountType: reward.discountType, value: reward.value, minCartSubtotalCents: reward.min }, eligible(reward.updatedAt));
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

    if (phases.amounts) {
      // The widget's per-market thresholds are stored in the market currency's unit, but the row does not say which currency
      // that is (it needs the Admin API), so they cannot be divided here.
      const widgetRows = await db
        .select({ id: appSettings.id, key: appSettings.key, value: appSettings.value, updatedAt: appSettings.updatedAt })
        .from(appSettings)
        .where(and(eq(appSettings.shopId, shop.id), like(appSettings.key, "widget.market_overrides.%"), lt(appSettings.updatedAt, options.before)));
      for (const row of widgetRows) {
        if (/"thresholdCents":\s*[1-9]/.test(row.value)) {
          result.skipped.push({ shop: shop.domain, table: "app_settings", id: row.key, reason: "market widget thresholds: the market currency is not stored, so resave them from the widget market page" });
        }
      }
    }

    if (options.apply) {
      const upsertMarker = (tx: Pick<Db, "insert">, key: string) => {
        const value = JSON.stringify({ at: now.toISOString(), before: options.before.toISOString(), rows: writes.length });
        return tx
          .insert(appSettings)
          .values({ shopId: shop.id, key, value })
          .onConflictDoUpdate({ target: [appSettings.shopId, appSettings.key], set: { value, updatedAt: now } });
      };
      await db.transaction(async (tx) => {
        for (const write of writes) await write(tx);
        if (phases.thresholds) await upsertMarker(tx, MIGRATION_MARKER_KEY);
        if (phases.amounts) await upsertMarker(tx, AMOUNTS_MARKER_KEY);
      });
      result.rowsWritten += writes.length;
    }
  }
  return result;
}
