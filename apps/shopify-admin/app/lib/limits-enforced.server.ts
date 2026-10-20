import { appSettings, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { insertAuditLog } from "./audit-log.server.js";

export const LIMITS_ENFORCED_KEY = "limits.enforced";

/** Per-shop rollout flag: only when on does compile emit mpc/mpu/ri. Read at publish time, so no cache. */
export async function isLimitsEnforced(db: Db, shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, LIMITS_ENFORCED_KEY)))
    .limit(1);
  return row?.value === "true";
}

export async function setLimitsEnforced(db: Db, shopId: string, enabled: boolean, performedBy?: string): Promise<void> {
  const before = await isLimitsEnforced(db, shopId);
  await db
    .insert(appSettings)
    .values({ shopId, key: LIMITS_ENFORCED_KEY, value: String(enabled) })
    .onConflictDoUpdate({
      target: [appSettings.shopId, appSettings.key],
      set: { value: String(enabled), updatedAt: new Date() },
    });
  await insertAuditLog(db, {
    shopId,
    entityType: "app_setting",
    entityId: LIMITS_ENFORCED_KEY,
    action: "limits_enforced_changed",
    before,
    after: enabled,
    performedBy,
  });
}

/**
 * Only shops listed in LIMITS_TOGGLE_SHOPS (comma-separated myshopify domains) can flip the flag; with the
 * variable unset nobody can. Offline sessions carry no user, so the shop allow-list is the gate.
 */
export function canToggleLimits(shopDomain: string): boolean {
  const allowed = (process.env["LIMITS_TOGGLE_SHOPS"] ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(shopDomain.trim().toLowerCase());
}
