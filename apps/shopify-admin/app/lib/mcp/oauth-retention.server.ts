import { and, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, mcpAuthCodes, mcpCredentials, mcpOauthClients, type Db } from "@promo/db";

const DAY_MS = 86_400_000;

/**
 * Nightly cleanup of OAuth state (called from the analytics-cleanup cron):
 * auth codes 1 day past expiry, revoked/expired access+refresh tokens 30 days past, and registered clients
 * older than 30 days that no code or token references any more. PATs are never touched here.
 */
export async function deleteExpiredMcpOauthState(
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<{ authCodes: number; credentials: number; clients: number }> {
  const codes = await db
    .delete(mcpAuthCodes)
    .where(lt(mcpAuthCodes.expiresAt, new Date(now.getTime() - DAY_MS)))
    .returning({ codeHash: mcpAuthCodes.codeHash });
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const credentials = await db
    .delete(mcpCredentials)
    .where(
      and(inArray(mcpCredentials.kind, ["access", "refresh"]), or(lt(mcpCredentials.revokedAt, cutoff), lt(mcpCredentials.expiresAt, cutoff))),
    )
    .returning({ id: mcpCredentials.id });
  const clients = await db
    .delete(mcpOauthClients)
    .where(
      and(
        lt(mcpOauthClients.createdAt, cutoff),
        sql`not exists (select 1 from ${mcpAuthCodes} where ${mcpAuthCodes.clientId} = ${mcpOauthClients.clientId})`,
        sql`not exists (select 1 from ${mcpCredentials} where ${mcpCredentials.clientId} = ${mcpOauthClients.clientId})`,
      ),
    )
    .returning({ clientId: mcpOauthClients.clientId });
  return { authCodes: codes.length, credentials: credentials.length, clients: clients.length };
}
