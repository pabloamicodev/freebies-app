import { and, eq } from "drizzle-orm";
import { appSettings, type Db } from "@promo/db";
import { parseStoredJson } from "./offer-validation.server.js";
import { insertAuditLog } from "./audit-log.server.js";
import type { AuthoringResult } from "./offer-authoring/types.js";

export const THEME_SETTINGS_KEY = "widget.global_theme";

export const CUSTOMIZE_DEFAULTS = {
  primaryColor: "#111111",
  accentColor: "#059669",
  buttonColor: "#111111",
  buttonTextColor: "#ffffff",
  backgroundColor: "#ffffff",
  textColor: "#111111",
  borderRadius: "8",
  fontFamily: "inherit",
  giftsLabel: "Free Gift",
  sliderTitle: "Choose Your Gift",
  progressBeforeGoal: "Spend {{remaining_amount}} more for a free gift!",
  progressAfterGoal: "🎁 You've unlocked your free gift!",
  todayOfferTitle: "Today's Deals",
  addToCartText: "Add to Cart",
  noThanksText: "No thanks",
};
export type CustomizeSettings = typeof CUSTOMIZE_DEFAULTS;

async function loadStored(db: Db, shopId: string): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, THEME_SETTINGS_KEY)))
    .limit(1);
  if (!row?.value) return null;
  const parsed = parseStoredJson(row.value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : null;
}

/** Stored theme laid over the defaults (what the admin page and the storefront see). */
export async function getCustomizeSettings(db: Db, shopId: string): Promise<{ theme: CustomizeSettings; stored: Record<string, string> }> {
  const stored = await loadStored(db, shopId);
  return { theme: { ...CUSTOMIZE_DEFAULTS, ...(stored as Partial<CustomizeSettings> | null) }, stored: stored ?? {} };
}

export type SetCustomizeInput = {
  values: Record<string, string>;
  /** `replace`: the stored theme becomes exactly `values` (what the admin form posts). `patch`: merged over the stored theme. */
  mode: "replace" | "patch";
};

export async function setCustomizeSettings(
  deps: { db: Db; shopId: string },
  input: SetCustomizeInput,
  opts: { dryRun?: boolean; performedBy?: string; auditExtra?: Record<string, unknown> } = {},
): Promise<AuthoringResult<{ theme: CustomizeSettings; changedKeys: string[]; written: boolean }>> {
  const before = await loadStored(deps.db, deps.shopId);
  const next = input.mode === "patch" ? { ...(before ?? {}), ...input.values } : { ...input.values };
  const effective = { ...CUSTOMIZE_DEFAULTS, ...(next as Partial<CustomizeSettings>) };
  const previous = { ...CUSTOMIZE_DEFAULTS, ...((before ?? {}) as Partial<CustomizeSettings>) };
  const changedKeys = Object.keys(effective).filter(
    (k) => (effective as Record<string, string>)[k] !== (previous as Record<string, string>)[k],
  );
  if (!opts.dryRun) {
    await deps.db
      .insert(appSettings)
      .values({ shopId: deps.shopId, key: THEME_SETTINGS_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: [appSettings.shopId, appSettings.key],
        set: { value: JSON.stringify(next), updatedAt: new Date() },
      });
    if (opts.performedBy) {
      await insertAuditLog(deps.db, { shopId: deps.shopId, entityType: "shop", entityId: deps.shopId, action: "customize_update", before: before ?? {}, after: { ...next, ...opts.auditExtra }, performedBy: opts.performedBy });
    }
  }
  return { ok: true, value: { theme: effective, changedKeys, written: !opts.dryRun } };
}
