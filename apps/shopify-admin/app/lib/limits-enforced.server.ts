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
 * Only the shop's account owner may flip the flag. Offline (token-exchange) sessions carry no user, so
 * LIMITS_TOGGLE_ENABLED=true is the explicit operator opt-in for them.
 */
export function canToggleLimits(session: { onlineAccessInfo?: { associated_user?: { account_owner?: boolean } } | null }): boolean {
  return session.onlineAccessInfo?.associated_user?.account_owner === true || process.env["LIMITS_TOGGLE_ENABLED"] === "true";
}
