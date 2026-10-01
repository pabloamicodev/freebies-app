import { and, eq, inArray } from "drizzle-orm";
import {
  offerConditions,
  offerRewards,
  offerVersions,
  offers,
  type Db,
} from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import {
  LEGACY_IMPORTER,
  insertPresetOffer,
  presetConditionRows,
  presetRewardRows,
  validateLegacyStorePreset,
  type LegacyOfferPreset,
  type LegacyStorePreset,
} from "./legacy-store-presets.server.js";

export const LEGACY_RECONCILER = "legacy-preset-reconciler";
/** Rows written in one transaction land within this window of each other. */
const SAME_WRITE_MS = 60_000;

export type ReconcileAction = "import" | "update" | "in_sync" | "manual_review";
export interface ReconcileResult {
  key: string;
  internalName: string;
  action: ReconcileAction;
  status: string | null;
  /** Why an offer needs manual review (empty otherwise). */
  reasons: string[];
  /** path: db=... preset=... lines for every difference. */
  diff: string[];
}

type OfferRow = typeof offers.$inferSelect;
type ConditionRow = typeof offerConditions.$inferSelect;
type RewardRow = typeof offerRewards.$inferSelect;
export interface ExistingOffer {
  offer: OfferRow;
  conditions: ConditionRow[];
  rewards: RewardRow[];
  versionCount: number;
}

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const short = (x: unknown) => {
  const s = JSON.stringify(x) ?? "undefined";
  return s.length > 2000 ? `${s.slice(0, 2000)}...` : s;
};

function diffValue(path: string, db: unknown, preset: unknown, out: string[]) {
  if (same(db, preset)) return;
  const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x);
  if (isObj(db) && isObj(preset)) {
    for (const k of new Set([...Object.keys(db), ...Object.keys(preset)])) {
      diffValue(`${path}.${k}`, db[k], preset[k], out);
    }
    return;
  }
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((i) => typeof i === "string");
  if (strings(db) && strings(preset)) {
    const inDb = new Set(db);
    const inPreset = new Set(preset);
    const dbOnly = db.filter((x) => !inPreset.has(x));
    const presetOnly = preset.filter((x) => !inDb.has(x));
    out.push(
      dbOnly.length || presetOnly.length
        ? `${path}: db-only=${short(dbOnly)} preset-only=${short(presetOnly)}`
        : `${path}: same members, different order`,
    );
    return;
  }
  out.push(`${path}: db=${short(db)} preset=${short(preset)}`);
}

export function diffOffer(existing: ExistingOffer, preset: LegacyOfferPreset): string[] {
  const out: string[] = [];
  const { offer } = existing;
  diffValue("offer.type", offer.type, preset.type, out);
  diffValue("offer.publicTitle", offer.publicTitle, preset.publicTitle, out);
  diffValue("offer.description", offer.description, preset.description, out);
  diffValue("offer.priority", offer.priority, preset.priority, out);

  const conds = [...existing.conditions].sort((a, b) => a.sortOrder - b.sortOrder);
  const wantConds = presetConditionRows("", "", preset);
  if (conds.length !== wantConds.length) {
    out.push(`conditions.count: db=${conds.length} (${conds.map((c) => `${c.scope}:${c.conditionType}`).join(",")}) preset=${wantConds.length}`);
  }
  wantConds.forEach((want, i) => {
    const have = conds[i];
    if (!have) return;
    const p = `condition[${i}]`;
    diffValue(`${p}.scope`, have.scope, want.scope, out);
    diffValue(`${p}.conditionType`, have.conditionType, want.conditionType, out);
    diffValue(`${p}.operator`, have.operator, want.operator, out);
    diffValue(`${p}.isEnabled`, have.isEnabled, want.isEnabled, out);
    diffValue(`${p}.value`, have.value, want.value, out);
  });

  const rews = [...existing.rewards].sort((a, b) => a.sortOrder - b.sortOrder);
  const wantRews = presetRewardRows("", "", preset);
  if (rews.length !== wantRews.length) {
    out.push(`rewards.count: db=${rews.length} (${rews.map((r) => r.rewardType).join(",")}) preset=${wantRews.length}`);
  }
  wantRews.forEach((want, i) => {
    const have = rews[i];
    if (!have) return;
    const p = `reward[${i}]`;
    for (const f of ["rewardType", "discountType", "quantity", "label", "isAutoAdd", "isCustomerSelectable"] as const) {
      diffValue(`${p}.${f}`, have[f], want[f], out);
    }
    diffValue(`${p}.value`, have.value, want.value, out);
    diffValue(`${p}.target`, have.target, want.target, out);
  });
  return out;
}

/** Reasons an existing offer must not be rewritten automatically (empty = pristine import). */
export function modificationReasons(existing: ExistingOffer): string[] {
  const { offer } = existing;
  const reasons: string[] = [];
  if (offer.status !== "draft") reasons.push(`status is ${offer.status}`);
  if (offer.updatedBy !== LEGACY_IMPORTER && offer.updatedBy !== LEGACY_RECONCILER) {
    reasons.push(`updatedBy is ${offer.updatedBy}`);
  }
  if (existing.versionCount > 0) reasons.push(`${existing.versionCount} offer_versions snapshot(s) (published before)`);
  // The importer / reconciler writes the offer and all of its rows in one transaction, so rows
  // created long after that, or touched after creation, were replaced or edited by hand.
  const baseline = (offer.updatedBy === LEGACY_RECONCILER ? offer.updatedAt : offer.createdAt).getTime();
  for (const row of [...existing.conditions, ...existing.rewards]) {
    const kind = "conditionType" in row ? "condition" : "reward";
    if (Math.abs(row.createdAt.getTime() - baseline) > SAME_WRITE_MS) {
      reasons.push(`a ${kind} row was created ${Math.round((row.createdAt.getTime() - baseline) / 1000)}s from the import (rows replaced)`);
      break;
    }
    if (row.updatedAt.getTime() - row.createdAt.getTime() > 1000) {
      reasons.push(`a ${kind} row was edited after creation`);
      break;
    }
  }
  return reasons;
}

export function planReconcile(
  preset: LegacyStorePreset,
  existingByName: Map<string, ExistingOffer>,
): ReconcileResult[] {
  return preset.offers.map((po) => {
    const base = { key: po.key, internalName: po.internalName };
    const existing = existingByName.get(po.internalName);
    if (!existing) {
      return { ...base, action: "import" as const, status: null, reasons: [], diff: [] };
    }
    const diff = diffOffer(existing, po);
    const status = existing.offer.status;
    if (diff.length === 0) return { ...base, action: "in_sync" as const, status, reasons: [], diff };
    const reasons = modificationReasons(existing);
    if (existing.offer.type !== po.type) reasons.push(`offer type differs (${existing.offer.type} vs ${po.type}); never changed automatically`);
    return {
      ...base,
      action: reasons.length ? ("manual_review" as const) : ("update" as const),
      status,
      reasons,
      diff,
    };
  });
}

async function loadExisting(db: Db, shopId: string, preset: LegacyStorePreset) {
  const names = preset.offers.map((o) => o.internalName);
  const offerRows: OfferRow[] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), inArray(offers.internalName, names)));
  const ids = offerRows.map((o) => o.id);
  const [conditionRows, rewardRows, versionRows] = ids.length
    ? await Promise.all([
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, ids))) as Promise<ConditionRow[]>,
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, ids))) as Promise<RewardRow[]>,
        db
          .select({ offerId: offerVersions.offerId })
          .from(offerVersions)
          .where(and(eq(offerVersions.shopId, shopId), inArray(offerVersions.offerId, ids))) as Promise<{ offerId: string }[]>,
      ])
    : [[], [], []];
  return new Map(
    offerRows.map((offer) => [
      offer.internalName,
      {
        offer,
        conditions: conditionRows.filter((c) => c.offerId === offer.id),
        rewards: rewardRows.filter((r) => r.offerId === offer.id),
        versionCount: versionRows.filter((v) => v.offerId === offer.id).length,
      },
    ]),
  );
}

/**
 * Brings already-imported legacy offers in line with the current preset.
 * Dry-run by default (reads only). With `apply`: missing offers are imported as drafts and
 * pristine drafts (status draft, never edited or published since import) get their
 * conditions/rewards replaced in one transaction per offer. Active, paused, published or
 * hand-edited offers are never written; they are returned as manual_review with the diff.
 * No offer_versions row is written: this repo snapshots versions only when an offer is published.
 */
export async function reconcileLegacyPreset(
  db: Db,
  shopId: string,
  preset: LegacyStorePreset,
  { apply = false }: { apply?: boolean } = {},
) {
  validateLegacyStorePreset(preset);
  const results = planReconcile(preset, await loadExisting(db, shopId, preset));
  if (apply) {
    const existing = await loadExisting(db, shopId, preset);
    for (const result of results) {
      const po = preset.offers.find((o) => o.key === result.key)!;
      if (result.action === "import") {
        await db.transaction((tx) => insertPresetOffer(tx, shopId, po));
      } else if (result.action === "update") {
        const offerId = existing.get(po.internalName)!.offer.id;
        await db.transaction(async (tx) => {
          const now = new Date();
          await tx.delete(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId)));
          await tx.delete(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId)));
          await tx.insert(offerConditions).values(presetConditionRows(shopId, offerId, po).map((r) => ({ ...r, createdAt: now, updatedAt: now })));
          await tx.insert(offerRewards).values(presetRewardRows(shopId, offerId, po).map((r) => ({ ...r, createdAt: now, updatedAt: now })));
          await tx
            .update(offers)
            .set({
              publicTitle: po.publicTitle,
              description: po.description,
              priority: po.priority,
              updatedBy: LEGACY_RECONCILER,
              updatedAt: now,
            })
            .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
        });
        await insertAuditLog(db, {
          shopId,
          entityType: "offer",
          entityId: offerId,
          action: "legacy_preset_reconcile",
          before: { diff: result.diff },
          after: { key: po.key },
          performedBy: LEGACY_RECONCILER,
        });
      }
    }
  }
  const count = (action: ReconcileAction) => results.filter((r) => r.action === action).length;
  return {
    applied: apply,
    results,
    counts: {
      import: count("import"),
      update: count("update"),
      inSync: count("in_sync"),
      manualReview: count("manual_review"),
    },
  };
}
