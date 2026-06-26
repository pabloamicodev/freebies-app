import type { getDb } from "@promo/db";
import { auditLogs } from "@promo/db";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type DbOrTx = ReturnType<typeof getDb> | Tx;

export interface AuditLogEntry {
  shopId: string;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  performedBy?: string;
}

export async function insertAuditLog(db: DbOrTx, entry: AuditLogEntry): Promise<void> {
  try {
    await (db as ReturnType<typeof getDb>).insert(auditLogs).values({
      shopId: entry.shopId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
      performedBy: entry.performedBy ?? null,
    });
  } catch (err) {
    // Audit log failures must never surface to the merchant.
    console.error("[audit-log] Failed to insert audit log", { ...entry, err });
  }
}
