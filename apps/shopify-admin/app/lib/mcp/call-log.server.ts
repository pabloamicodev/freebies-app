import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { mcpCallLog, type Db } from "@promo/db";
import { checkRateLimit } from "../rate-limit.server.js";
import { toErrorCallToolResult, type McpContext } from "./server.server.js";
import { ToolError, parsePromoRef } from "./result.server.js";

export type RateClass = "read" | "write" | "critical";
export const RATE_LIMITS: Record<RateClass, number> = { read: 60, write: 10, critical: 3 };
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export type RateLimiter = (key: string, limit: number) => Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;

const defaultRateLimiter: RateLimiter = (key, limit) =>
  checkRateLimit(key, { limit, windowMs: 60_000, onRedisUnavailable: "memory" });

/** Per operator and class, per minute: 60 reads, 10 writes (dry runs included), 3 critical executions. */
export async function enforceOperatorRate(ctx: Pick<McpContext, "operator" | "rateLimit">, cls: RateClass): Promise<void> {
  const verdict = await (ctx.rateLimit ?? defaultRateLimiter)(`mcp:${cls}:${ctx.operator.id}`, RATE_LIMITS[cls]);
  if (!verdict.ok) {
    throw new ToolError("RATE_LIMITED", `Too many ${cls} calls; wait ${verdict.retryAfterSeconds}s.`, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }
}

const SENSITIVE_KEY = /token|secret|password|authorization|credential|cookie/i;
const MAX_STRING = 300;
const MAX_ITEMS = 50;
const MAX_DEPTH = 4;

/** Args as stored in the log: secrets masked, long strings and arrays cut, depth bounded. */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redactArgs(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS} more]`] : items;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redactArgs(v, depth + 1)]),
  );
}

/** Best-effort shop list from the common argument names; only used for the log. */
export function shopsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  const found = new Set<string>();
  const add = (v: unknown) => typeof v === "string" && v && found.add(v.slice(0, 120));
  for (const key of ["shop", "targetShop"]) add(a[key]);
  if (Array.isArray(a["shops"])) a["shops"].slice(0, MAX_ITEMS).forEach(add);
  if (typeof a["ref"] === "string") add(parsePromoRef(a["ref"])?.shopHandle);
  return [...found];
}

export type CallLogEntry = {
  operatorId: string;
  tool: string;
  shops: string[];
  args: unknown;
  outcome: string;
  durationMs: number;
};

/** Logging must never break a call, so a failed insert is reported and swallowed. */
export async function logCall(db: Db, entry: CallLogEntry): Promise<void> {
  try {
    await db.insert(mcpCallLog).values({
      operatorId: entry.operatorId,
      tool: entry.tool,
      shops: entry.shops,
      argsRedacted: redactArgs(entry.args),
      outcome: entry.outcome,
      durationMs: Math.round(entry.durationMs),
    });
  } catch (error) {
    console.error("[mcp-call-log] insert failed", error instanceof Error ? error.message : "unknown");
  }
}

export function outcomeOf(result: CallToolResult): string {
  if (!result.isError) return "ok";
  const code = (result.structuredContent as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "INTERNAL";
}

/**
 * Wraps every read-only tool registered afterwards with the read rate limit and a call-log row.
 * Write tools (no readOnlyHint) are passed through untouched: they limit and log themselves in runWrite.
 */
export function instrumentReadTools(server: McpServer, ctx: McpContext): void {
  const original = server.registerTool.bind(server);
  const patched = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: (...a: unknown[]) => Promise<CallToolResult>) => {
    if (config.annotations?.readOnlyHint !== true) return original(name, config as never, handler as never);
    const wrapped = async (...cbArgs: unknown[]): Promise<CallToolResult> => {
      const args = cbArgs.length > 1 ? cbArgs[0] : undefined;
      const started = performance.now();
      let result: CallToolResult;
      try {
        await enforceOperatorRate(ctx, "read");
        result = await handler(...cbArgs);
      } catch (error) {
        result = toErrorCallToolResult(error);
      }
      await logCall(ctx.db, {
        operatorId: ctx.operator.id,
        tool: name,
        shops: shopsFromArgs(args),
        args,
        outcome: outcomeOf(result),
        durationMs: performance.now() - started,
      });
      return result;
    };
    return original(name, config as never, wrapped as never);
  }) as McpServer["registerTool"];
  server.registerTool = patched;
}

export type StoredResult = { argsHash: string; result: unknown };

/** The executed write this operator already ran under the same idempotency key in the last 24 h, if any. */
export async function findIdempotent(
  db: Db,
  operatorId: string,
  tool: string,
  key: string,
  now: Date,
): Promise<{ id: string; outcome: string; stored: StoredResult | null } | null> {
  const [row] = await db
    .select({ id: mcpCallLog.id, outcome: mcpCallLog.outcome, resultRef: mcpCallLog.resultRef, createdAt: mcpCallLog.createdAt })
    .from(mcpCallLog)
    .where(and(eq(mcpCallLog.operatorId, operatorId), eq(mcpCallLog.tool, tool), eq(mcpCallLog.idempotencyKey, key)))
    .limit(1);
  if (!row) return null;
  if (now.getTime() - row.createdAt.getTime() >= IDEMPOTENCY_TTL_MS) {
    // Expired: free the key so the unique index lets it be used again.
    await db.update(mcpCallLog).set({ idempotencyKey: null }).where(eq(mcpCallLog.id, row.id));
    return null;
  }
  return { id: row.id, outcome: row.outcome, stored: (row.resultRef as StoredResult | null) ?? null };
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Claims the single-use jti (and the idempotency key) BEFORE the write runs: the unique constraints are
 * what make a token or key usable once even under concurrent calls.
 */
export async function claimWrite(
  db: Db,
  input: { operatorId: string; tool: string; shops: string[]; args: unknown; jti: string; idempotencyKey?: string },
): Promise<{ ok: true; id: string } | { ok: false; reason: "jti" | "idempotency" }> {
  try {
    const [row] = await db
      .insert(mcpCallLog)
      .values({
        operatorId: input.operatorId,
        tool: input.tool,
        shops: input.shops,
        argsRedacted: redactArgs(input.args),
        outcome: "pending",
        confirmJti: input.jti,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: mcpCallLog.id });
    return { ok: true, id: row!.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [byJti] = await db.select({ id: mcpCallLog.id }).from(mcpCallLog).where(eq(mcpCallLog.confirmJti, input.jti)).limit(1);
    return { ok: false, reason: byJti ? "jti" : "idempotency" };
  }
}

export async function finishWrite(
  db: Db,
  id: string,
  outcome: string,
  durationMs: number,
  stored: StoredResult | null,
): Promise<void> {
  await db
    .update(mcpCallLog)
    // A failed execution frees its idempotency key (the jti stays burned), so a retry after a fresh dry run can reuse it.
    .set({ outcome, durationMs: Math.round(durationMs), resultRef: stored, ...(stored ? {} : { idempotencyKey: null }) })
    .where(eq(mcpCallLog.id, id));
}
