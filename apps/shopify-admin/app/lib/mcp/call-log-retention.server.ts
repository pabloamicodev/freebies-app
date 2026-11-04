import { and, eq, lt } from "drizzle-orm";
import { getDb, mcpCallLog, mcpCredentials, type Db } from "@promo/db";

const DAY_MS = 86_400_000;
export const CALL_LOG_RETENTION_DAYS = 90;
export const PAT_EXPIRY_GRACE_DAYS = 7;

/**
 * Nightly cleanup (analytics-cleanup cron, next to the OAuth cleanup): call-log rows older than 90 days and
 * PATs expired for more than 7 days (access/refresh tokens are handled by deleteExpiredMcpOauthState).
 */
export async function deleteExpiredMcpCallState(
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<{ callLog: number; expiredPats: number }> {
  const calls = await db
    .delete(mcpCallLog)
    .where(lt(mcpCallLog.createdAt, new Date(now.getTime() - CALL_LOG_RETENTION_DAYS * DAY_MS)))
    .returning({ id: mcpCallLog.id });
  const pats = await db
    .delete(mcpCredentials)
    .where(and(eq(mcpCredentials.kind, "pat"), lt(mcpCredentials.expiresAt, new Date(now.getTime() - PAT_EXPIRY_GRACE_DAYS * DAY_MS))))
    .returning({ id: mcpCredentials.id });
  return { callLog: calls.length, expiredPats: pats.length };
}
