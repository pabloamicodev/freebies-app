import { and, eq } from "drizzle-orm";
import { offerConditions, offers, type Db } from "@promo/db";
import { insertAuditLog } from "./audit-log.server.js";
import { fromStoredAmount, overrideUnit, toStoredAmount } from "./money.js";
import { republishIfActive } from "./offer-publish-flow.server.js";
import type { AuthoringDeps, WriteServiceOptions } from "./offer-authoring/types.js";

/**
 * Per-currency overrides on the offer's cart_value condition. Amounts are MAJOR units typed by a person
 * (5.25, 500). Storage unit per currency follows `overrideUnit` (money.ts): whole units on a zero-decimal
 * shop (JPY: 500 stays 500), x100 on every other shop whatever the market currency. Same as the admin page.
 */
export type CurrencyOverrideInput = {
  currency: string;
  /** Cart value threshold for this currency. null or 0 removes the override; undefined keeps it (patch) or leaves it unset (replace). */
  threshold?: number | null;
  /** Maximum cart value (only meaningful when the base condition has a maximum). Must be >= threshold. */
  max?: number | null;
  /** Fixed discount amount for this currency. */
  fixed?: number | null;
};

export type SetMulticurrencyInput = {
  overrides: CurrencyOverrideInput[];
  /** `replace`: the three maps become exactly these overrides (what the admin form posts). `patch`: merged per currency. */
  mode: "replace" | "patch";
};

type Maps = { currencyOverrides: Record<string, number>; maxCurrencyOverrides: Record<string, number>; fixedAmountOverrides: Record<string, number> };

export type MulticurrencyView = Maps & {
  offerId: string;
  baseThresholdCents: number;
  baseMaxCents: number | null;
  baseCurrency: string;
  /** Same maps in major units, per currency, for readability. */
  major: Record<string, { threshold?: number; max?: number; fixed?: number }>;
};

export type MulticurrencyFailure =
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "validation"; error: string }
  | { ok: false; code: "state"; error: string }
  | { ok: false; code: "publish_failed"; error: string };

type Deps = Pick<AuthoringDeps, "db" | "shopId" | "shopDomain" | "shopCurrency">;
type Opts = Partial<Pick<WriteServiceOptions, "performedBy" | "auditExtra" | "dryRun" | "publish" | "expectedUpdatedAt">>;

async function loadCartValue(db: Db, shopId: string, offerId: string) {
  const [offer] = await db
    .select({ id: offers.id, status: offers.status, updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);
  if (!offer) return null;
  const [condition] = await db
    .select()
    .from(offerConditions)
    .where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.conditionType, "cart_value")))
    .limit(1);
  return { offer, condition };
}

const mapOf = (value: Record<string, unknown>, key: string) => ({ ...((value[key] ?? {}) as Record<string, number>) });

export async function getMulticurrency(deps: Pick<Deps, "db" | "shopId" | "shopCurrency">, offerId: string): Promise<
  { ok: true; value: MulticurrencyView | null } | Extract<MulticurrencyFailure, { code: "not_found" }>
> {
  const loaded = await loadCartValue(deps.db, deps.shopId, offerId);
  if (!loaded) return { ok: false, code: "not_found", error: "Offer not found in that shop." };
  if (!loaded.condition) return { ok: true, value: null };
  const value = loaded.condition.value as Record<string, unknown>;
  const maps: Maps = {
    currencyOverrides: mapOf(value, "currencyOverrides"),
    maxCurrencyOverrides: mapOf(value, "maxCurrencyOverrides"),
    fixedAmountOverrides: mapOf(value, "fixedAmountOverrides"),
  };
  const major: MulticurrencyView["major"] = {};
  const put = (map: Record<string, number>, field: "threshold" | "max" | "fixed") => {
    for (const [currency, stored] of Object.entries(map)) {
      (major[currency] ??= {})[field] = fromStoredAmount(stored, overrideUnit(deps.shopCurrency, currency));
    }
  };
  put(maps.currencyOverrides, "threshold");
  put(maps.maxCurrencyOverrides, "max");
  put(maps.fixedAmountOverrides, "fixed");
  return {
    ok: true,
    value: {
      ...maps,
      offerId,
      baseThresholdCents: (value["thresholdCents"] as number | undefined) ?? 0,
      baseMaxCents: (value["maxCents"] as number | undefined) ?? null,
      baseCurrency: (value["currencyCode"] as string | undefined) ?? "USD",
      major,
    },
  };
}

function applyField(map: Record<string, number>, currency: string, raw: number | null | undefined, shopCurrency: string, mode: "replace" | "patch") {
  if (raw === undefined) return;
  const stored = Number.isFinite(raw) && (raw as number) > 0 ? toStoredAmount(raw as number, overrideUnit(shopCurrency, currency)) : 0;
  if (stored > 0) map[currency] = stored;
  else if (mode === "patch") delete map[currency];
}

export type SetMulticurrencyResult = Maps & { offerId: string; offerStatus: string; republished: boolean; written: boolean };

export async function setMulticurrency(
  deps: Deps,
  offerId: string,
  input: SetMulticurrencyInput,
  opts: Opts = {},
): Promise<{ ok: true; value: SetMulticurrencyResult } | MulticurrencyFailure> {
  const loaded = await loadCartValue(deps.db, deps.shopId, offerId);
  if (!loaded) return { ok: false, code: "not_found", error: "Offer not found in that shop." };
  if (!loaded.condition) {
    return { ok: false, code: "validation", error: "No cart value condition found. Add a Cart Value condition on the Conditions page first." };
  }
  if (opts.expectedUpdatedAt && loaded.offer.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()) {
    return { ok: false, code: "state", error: "The offer changed since it was read; read it again and retry." };
  }

  const current = loaded.condition.value as Record<string, unknown>;
  const maps: Maps =
    input.mode === "patch"
      ? { currencyOverrides: mapOf(current, "currencyOverrides"), maxCurrencyOverrides: mapOf(current, "maxCurrencyOverrides"), fixedAmountOverrides: mapOf(current, "fixedAmountOverrides") }
      : { currencyOverrides: {}, maxCurrencyOverrides: {}, fixedAmountOverrides: {} };

  const entries = input.overrides.map((o) => ({ ...o, currency: o.currency.trim().toUpperCase() })).filter((o) => o.currency);
  for (const o of entries) applyField(maps.currencyOverrides, o.currency, o.threshold, deps.shopCurrency, input.mode);
  for (const o of entries) {
    applyField(maps.maxCurrencyOverrides, o.currency, o.max, deps.shopCurrency, input.mode);
    const minimum = maps.currencyOverrides[o.currency];
    const maximum = maps.maxCurrencyOverrides[o.currency];
    if (minimum !== undefined && maximum !== undefined && maximum < minimum) {
      return { ok: false, code: "validation", error: `${o.currency} maximum must be greater than or equal to its threshold.` };
    }
  }
  for (const o of entries) applyField(maps.fixedAmountOverrides, o.currency, o.fixed, deps.shopCurrency, input.mode);

  const base = { offerId, offerStatus: loaded.offer.status, ...maps };
  if (opts.dryRun) return { ok: true, value: { ...base, republished: false, written: false } };

  await deps.db.transaction(async (tx) => {
    await tx
      .update(offerConditions)
      .set({ value: { ...current, ...maps }, updatedAt: new Date() })
      .where(and(eq(offerConditions.shopId, deps.shopId), eq(offerConditions.offerId, offerId), eq(offerConditions.id, loaded.condition!.id)));
  });
  if (opts.performedBy) {
    await insertAuditLog(deps.db, {
      shopId: deps.shopId,
      entityType: "offer",
      entityId: offerId,
      action: "multicurrency_update",
      before: { currencyOverrides: mapOf(current, "currencyOverrides"), maxCurrencyOverrides: mapOf(current, "maxCurrencyOverrides"), fixedAmountOverrides: mapOf(current, "fixedAmountOverrides") },
      after: { ...maps, ...opts.auditExtra },
      performedBy: opts.performedBy,
    });
  }
  const wasActive = loaded.offer.status === "active";
  const publishError = await republishIfActive(deps.db, deps.shopId, deps.shopDomain, offerId, wasActive, opts.publish);
  if (publishError) return { ok: false, code: "publish_failed", error: publishError };
  return { ok: true, value: { ...base, republished: wasActive, written: true } };
}
