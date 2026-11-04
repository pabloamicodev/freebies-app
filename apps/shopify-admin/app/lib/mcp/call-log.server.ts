import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { mcpCallLog, type Db } from "@promo/db";
import { checkRateLimit } from "../rate-limit.server.js";
import { toErrorCallToolResult, type McpContext } from "./server.server.js";
import { ToolError, parsePromoRef } from "./result.server.js";

export type RateClass = "read" | "write" | "critical";
export const RATE_LIMITS: Record<RateClass, number> = { read: 60, write: 10, critical: 3 };
const RATE_ENV: Record<RateClass, string> = { read: "MCP_RATE_READS", write: "MCP_RATE_WRITES", critical: "MCP_RATE_CRITICAL" };
const RATE_MAX = 600;

/** Per-minute limit for a class: MCP_RATE_READS/WRITES/CRITICAL when an integer in 1..600, else the default. */
export function rateLimitFor(cls: RateClass, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RATE_ENV[cls]]?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n >= 1 && n <= RATE_MAX ? n : RATE_LIMITS[cls];
}

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export type RateLimiter = (key: string, limit: number) => Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;

const defaultRateLimiter: RateLimiter = (key, limit) =>
  checkRateLimit(key, { limit, windowMs: 60_000, onRedisUnavailable: "memory" });

/** Per operator and class, per minute: 60 reads, 10 writes (dry runs included), 3 critical executions. */
export async function enforceOperatorRate(ctx: Pick<McpContext, "operator" | "rateLimit">, cls: RateClass): Promise<void> {
  const verdict = await (ctx.rateLimit ?? defaultRateLimiter)(`mcp:${cls}:${ctx.operator.id}`, rateLimitFor(cls));
  if (!verdict.ok) {
    throw new ToolError("RATE_LIMITED", `Too many ${cls} calls; wait ${verdict.retryAfterSeconds}s.`, {
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }
}

/** Never logged, whatever a tool's allow list says. */
const NEVER_KEY = /token|secret|password|authorization|credential|cookie|email|phone|code/i;
const COMMON_KEYS = ["dryRun", "ref", "shop", "shops", "targetShop", "offerId", "templateId", "status", "all", "batchId"];
const READ_KEYS = ["types", "limit", "cursor", "groupBy", "start", "end", "lastDays", "live", "includeUninstalled", "goal", "actor", "since"];
/** Logged as `<key>Count` only: lists of ids or URLs. */
const COUNT_KEYS = new Set(["ids", "excludeUrls", "pageUrls"]);
const TOOL_KEYS: Record<string, string[]> = {
  promo_set_schedule: ["startsAt", "endsAt"],
  promos_pause_all: [],
  promo_activate_draft: [],
  codes_create_batch: ["count", "length"],
  codes_delete: ["onlyUnused"],
  shop_set_limits_enforced: ["enforced"],
};
const MAX_VALUE = 120;
const MAX_ITEMS = 20;
const PII_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+|\+?\d[\d\s().-]{7,}\d/;

/** A uuid, alone or inside promo:<handle>:<uuid>: random digit runs in it must not be mistaken for a phone number. */
const ID_VALUE = /^(?:promo:[a-z0-9.-]{1,80}:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeScalar(value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  if (ID_VALUE.test(value)) return value;
  if (PII_VALUE.test(value)) return "[masked]";
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}...` : value;
}

/**
 * Args as stored in the log: an allow list per tool (ids, refs, shops, dryRun, status, limits, dates). Free text
 * (reason, q, names, URLs, overrides) and anything keyed like email/phone/code/token is dropped; only the dropped
 * key names are kept in `_omitted`, and id/URL lists are reduced to a count.
 */
export function redactArgs(tool: string, args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const allowed = new Set([...COMMON_KEYS, ...(TOOL_KEYS[tool] ?? READ_KEYS)]);
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || key === "idempotencyKey") continue;
    if (NEVER_KEY.test(key)) {
      omitted.push(key);
    } else if (COUNT_KEYS.has(key)) {
      if (Array.isArray(value)) out[`${key}Count`] = value.length;
    } else if (!allowed.has(key)) {
      omitted.push(key);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, MAX_ITEMS).map(safeScalar).filter((v) => v !== undefined);
    } else {
      const scalar = safeScalar(value);
      if (scalar !== undefined) out[key] = scalar;
    }
  }
  if (omitted.length) out["_omitted"] = omitted.sort();
  return out;
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
      argsRedacted: redactArgs(entry.tool, entry.args),
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
        argsRedacted: redactArgs(input.tool, input.args),
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
