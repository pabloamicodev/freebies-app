import { z } from "zod";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { auditLogs, type Db } from "@promo/db";
import { buildResult, parsePromoRef, promoRef, shopHandle, ToolError, type ToolResult } from "../result.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { DAY_MS, clampLimit, decodeCursor, encodeCursor, iso } from "./insights-common.server.js";

export const promoAuditLogInput = {
  shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop."),
  ref: z.string().optional().describe("promo:<shopHandle>:<offerId>; only the audit trail of that offer."),
  actor: z.string().optional().describe('performedBy filter: "system", "mcp:<operatorId>" or the operator id.'),
  since: z.string().optional().describe("ISO 8601 lower bound (default: last 30 days; max 365 days back)."),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

const MAX_BACK_DAYS = 365;
const DEFAULT_BACK_DAYS = 30;

const SECRET_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential|signature|cookie|pepper|private|client[_-]?secret/i;
const PII_KEY = /^(email|e[_-]?mail|phone|mobile|first[_-]?name|last[_-]?name|full[_-]?name|address\d?|street|zip|postcode|ip|ip[_-]?address|user[_-]?agent|customer[_-]?(id|gid|email)|session[_-]?id|cart[_-]?token|order[_-]?(id|gid)|checkout[_-]?token)$/i;
const EMAIL_VALUE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g;
const MAX_STRING = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 60;

export const REDACTED = "[redacted]";

/** Drops secret/PII keys, masks emails inside strings, bounds depth and size. Pure. */
export function sanitizeAuditJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replace(EMAIL_VALUE, "[email]").slice(0, MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeAuditJson(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (SECRET_KEY.test(key) || PII_KEY.test(key)) continue;
      out[key] = sanitizeAuditJson(v, depth + 1);
    }
    return out;
  }
  return null;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type AuditChange = { field: string; before: unknown; after: unknown };

/** Top-level fields whose value differs, from already-sanitized before/after. */
export function changesOf(before: unknown, after: unknown, max = 20): AuditChange[] {
  const b = asObject(before);
  const a = asObject(after);
  const changes: AuditChange[] = [];
  for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (JSON.stringify(b[field] ?? null) !== JSON.stringify(a[field] ?? null)) {
      changes.push({ field, before: b[field] ?? null, after: a[field] ?? null });
      if (changes.length >= max) break;
    }
  }
  return changes;
}

/** Staff emails or ids must not leak: emails are masked, everything else is bounded. */
export function maskActor(performedBy: string | null): string | null {
  if (!performedBy) return null;
  const masked = performedBy.replace(EMAIL_VALUE, (m) => {
    const [local = "", domain = ""] = m.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
  });
  return masked.slice(0, 120);
}

export type AuditEvent = {
  id: string;
  at: string;
  shopDomain: string;
  entityType: string;
  entityId: string;
  promoRef?: string;
  action: string;
  actor: string | null;
  actorKind: "mcp" | "system" | "merchant" | "unknown";
  summary: string;
  changes: AuditChange[];
  before: unknown;
  after: unknown;
};

function actorKind(performedBy: string | null): AuditEvent["actorKind"] {
  if (!performedBy) return "unknown";
  if (performedBy.startsWith("mcp:")) return "mcp";
  if (performedBy === "system") return "system";
  return "merchant";
}

export async function promoAuditLog(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; ref?: string; actor?: string; since?: string; cursor?: string; limit?: number },
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ events: AuditEvent[] }>> {
  const current = now();
  const limit = clampLimit(args.limit);
  const floor = new Date(current.getTime() - MAX_BACK_DAYS * DAY_MS);
  let since = new Date(current.getTime() - DEFAULT_BACK_DAYS * DAY_MS);
  if (args.since) {
    since = new Date(args.since);
    if (Number.isNaN(since.getTime())) throw new ToolError("VALIDATION", "since must be an ISO 8601 date-time.");
    if (since < floor) since = floor;
  }

  let selected: VisibleShop[];
  let entityId: string | undefined;
  if (args.ref) {
    const parsed = parsePromoRef(args.ref);
    if (!parsed) throw new ToolError("VALIDATION", "ref must look like promo:<shopHandle>:<offerId>.");
    selected = selectShops(visible, [parsed.shopHandle]);
    entityId = parsed.offerId;
  } else {
    selected = selectShops(visible, args.shops);
  }
  const byId = new Map(selected.map((s) => [s.id, s]));

  const cursor = decodeCursor<{ t?: unknown; id?: unknown }>(args.cursor);
  if (cursor && (typeof cursor.t !== "string" || typeof cursor.id !== "string" || !/^[0-9T:. +-]+Z?$/.test(cursor.t))) {
    throw new ToolError("VALIDATION", "Invalid cursor. Start again without one.");
  }

  const actorFilter = args.actor
    ? or(
        eq(auditLogs.performedBy, args.actor),
        eq(auditLogs.performedBy, `mcp:${args.actor}`),
      )
    : undefined;

  const rows = selected.length === 0
    ? []
    : await db
        .select({
          id: auditLogs.id,
          shopId: auditLogs.shopId,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          before: auditLogs.before,
          after: auditLogs.after,
          performedBy: auditLogs.performedBy,
          createdAt: auditLogs.createdAt,
          ts: sql<string>`${auditLogs.createdAt}::text`,
        })
        .from(auditLogs)
        .where(
          and(
            inArray(auditLogs.shopId, selected.map((s) => s.id)),
            gte(auditLogs.createdAt, since),
            entityId ? eq(auditLogs.entityType, "offer") : undefined,
            entityId ? eq(auditLogs.entityId, entityId) : undefined,
            actorFilter,
            cursor
              ? sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${cursor.t as string}::timestamptz, ${cursor.id as string}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const events: AuditEvent[] = pageRows.map((r) => {
    const shop = byId.get(r.shopId)!;
    const before = sanitizeAuditJson(r.before);
    const after = sanitizeAuditJson(r.after);
    const changes = changesOf(before, after);
    const actor = maskActor(r.performedBy);
    return {
      id: r.id,
      at: iso(r.createdAt)!,
      shopDomain: shop.myshopifyDomain,
      entityType: r.entityType,
      entityId: r.entityId,
      ...(r.entityType === "offer" ? { promoRef: promoRef(shop.myshopifyDomain, r.entityId) } : {}),
      action: r.action,
      actor,
      actorKind: actorKind(r.performedBy),
      summary: `${r.action} on ${r.entityType} by ${actor ?? "unknown"}${changes.length ? `; changed ${changes.map((c) => c.field).join(", ")}` : ""}`,
      changes,
      before,
      after,
    };
  });

  const last = pageRows[pageRows.length - 1];
  const summary = [
    `${events.length} audit event(s) since ${since.toISOString().slice(0, 10)} across ${selected.length} shop(s).`,
    ...events.slice(0, 8).map((e) => `- ${e.at.slice(0, 16)} ${shopHandle(e.shopDomain)} ${e.summary}`),
    hasMore ? "More events are available with the cursor." : "",
  ].filter(Boolean).join("\n");

  return buildResult(
    {
      summary,
      data: { events },
      perShop: selected.map((s) => ({
        shopDomain: s.myshopifyDomain,
        shopHandle: shopHandle(s.myshopifyDomain),
        shopTimezone: s.timezone,
        currency: s.currencyCode,
        status: "ok" as const,
      })),
      warnings: args.since && new Date(args.since) < floor
        ? [{ code: "SINCE_CLAMPED", severity: "info", message: `since was clamped to ${MAX_BACK_DAYS} days back.` }]
        : [],
      nextActions: [],
      meta: {
        window: { start: since.toISOString(), end: current.toISOString() },
        page: { hasMore, ...(hasMore && last ? { cursor: encodeCursor({ t: last.ts, id: last.id }) } : {}) },
      },
    },
    now,
  );
}
