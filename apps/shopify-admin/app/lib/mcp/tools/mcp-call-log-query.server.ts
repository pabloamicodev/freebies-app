import { z } from "zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { mcpCallLog, mcpOperators, type Db } from "@promo/db";
import type { Operator } from "../auth.server.js";
import { buildResult, ToolError, type ToolResult } from "../result.server.js";
import { decodeCursor, encodeCursor } from "./insights-common.server.js";

export const mcpCallLogQueryInput = {
  operatorEmail: z.string().max(254).optional().describe("Only calls by this operator (exact email, case-insensitive). The email is never returned."),
  tool: z.string().max(80).optional().describe("Exact tool name, e.g. promos_pause_all."),
  outcome: z.string().max(40).optional().describe('"ok", "pending" or an error code such as VALIDATION or STATE_CONFLICT.'),
  since: z.string().optional().describe("ISO 8601 lower bound (inclusive)."),
  until: z.string().optional().describe("ISO 8601 upper bound (inclusive)."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200."),
  cursor: z.string().optional(),
};

export type CallLogRow = {
  id: string;
  at: string;
  operatorId: string | null;
  operatorName: string | null;
  tool: string;
  shops: string[];
  args: unknown;
  outcome: string;
  durationMs: number | null;
};

const DEFAULT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ToolError("VALIDATION", `${field} must be an ISO 8601 date-time.`);
  return date;
}

export async function mcpCallLogQuery(
  db: Db,
  _operator: Operator,
  args: { operatorEmail?: string; tool?: string; outcome?: string; since?: string; until?: string; limit?: number; cursor?: string },
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ calls: CallLogRow[] }>> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const since = parseDate(args.since, "since");
  const until = parseDate(args.until, "until");
  const cursor = decodeCursor<{ t?: unknown; id?: unknown }>(args.cursor);
  if (cursor && (typeof cursor.t !== "string" || !TS.test(cursor.t) || typeof cursor.id !== "string" || !UUID.test(cursor.id))) {
    throw new ToolError("VALIDATION", "Invalid cursor. Start again without one.");
  }

  const rows = await db
    .select({
      id: mcpCallLog.id,
      operatorId: mcpCallLog.operatorId,
      operatorName: mcpOperators.name,
      tool: mcpCallLog.tool,
      shops: mcpCallLog.shops,
      args: mcpCallLog.argsRedacted,
      outcome: mcpCallLog.outcome,
      durationMs: mcpCallLog.durationMs,
      createdAt: mcpCallLog.createdAt,
      ts: sql<string>`to_char(${mcpCallLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(mcpCallLog)
    .leftJoin(mcpOperators, eq(mcpOperators.id, mcpCallLog.operatorId))
    .where(
      and(
        args.operatorEmail ? eq(mcpOperators.email, args.operatorEmail.trim().toLowerCase()) : undefined,
        args.tool ? eq(mcpCallLog.tool, args.tool) : undefined,
        args.outcome ? eq(mcpCallLog.outcome, args.outcome) : undefined,
        since ? gte(mcpCallLog.createdAt, since) : undefined,
        until ? lte(mcpCallLog.createdAt, until) : undefined,
        cursor ? sql`(${mcpCallLog.createdAt}, ${mcpCallLog.id}) < (${cursor.t as string}::timestamptz, ${cursor.id as string}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(mcpCallLog.createdAt), desc(mcpCallLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const calls: CallLogRow[] = page.map((r) => ({
    id: r.id,
    at: r.ts,
    operatorId: r.operatorId,
    operatorName: r.operatorName,
    tool: r.tool,
    shops: r.shops,
    args: r.args,
    outcome: r.outcome,
    durationMs: r.durationMs,
  }));
  const last = page[page.length - 1];
  const summary = [
    `${calls.length} MCP call(s), newest first.`,
    ...calls.slice(0, 8).map((c) => `- ${c.at.slice(0, 19)} ${c.operatorName ?? "unknown"} ${c.tool} -> ${c.outcome}`),
    hasMore ? "More calls are available with the cursor." : "",
  ]
    .filter(Boolean)
    .join("\n");

  return buildResult(
    {
      summary,
      data: { calls },
      meta: { page: { hasMore, ...(hasMore && last ? { cursor: encodeCursor({ t: last.ts, id: last.id }) } : {}) } },
    },
    now,
  );
}
