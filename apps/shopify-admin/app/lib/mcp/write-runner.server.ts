import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpRole } from "./auth.server.js";
import {
  claimWrite,
  enforceOperatorRate,
  findIdempotent,
  finishWrite,
  logCall,
  outcomeOf,
  shopsFromArgs,
  type StoredResult,
} from "./call-log.server.js";
import { hashArgs, verifyConfirmToken } from "./confirm.server.js";
import type { ShopRef } from "./multi-shop.server.js";
import { ToolError, buildResult, type Link, type NextAction, type ToolResult, type Warning } from "./result.server.js";
import { toCallToolResult, toErrorCallToolResult, type McpContext } from "./server.server.js";
import { runWithCapacitySource } from "../capacity-source.server.js";
import type { OfferLifecycleFailure, ShopPublishFn } from "../offer-lifecycle.server.js";

export type WriteBody = {
  summary: string;
  data: Record<string, unknown>;
  warnings?: Warning[];
  links?: Link[];
  nextActions?: NextAction[];
};
/** `setHash`: optional digest of the exact set of rows the dry run would touch, bound into the confirm token. */
export type WritePreview = WriteBody & { offerUpdatedAt: Date | null; setHash?: string | null };

export type ApplyContext = {
  /** The offer's updated_at the operator saw in the dry run; the write refuses (STATE_CONFLICT) if it moved. */
  expectedUpdatedAt: Date | null;
  /** The setHash the dry run bound into the token, if any; the write refuses (STATE_CONFLICT) when the set differs. */
  expectedSetHash: string | null;
  performedBy: string;
  auditExtra: Record<string, unknown>;
  publish: ShopPublishFn | undefined;
};

export type WriteSpec = {
  tool: string;
  /** Ignored since 2026-11-13 (owner: every authenticated operator can call every tool). Kept so older specs compile. */
  minRole?: McpRole;
  /** Ignored since 2026-11-13; kept so older specs compile. */
  critical?: boolean;
  /** The tool's raw arguments, including dryRun / confirmToken / idempotencyKey. */
  args: Record<string, unknown>;
  dryRun: boolean;
  confirmToken?: string;
  idempotencyKey?: string;
  /** Every shop the call touches; logged with the call. */
  shops: ShopRef[];
  preview: () => Promise<WritePreview>;
  apply: (apply: ApplyContext) => Promise<WriteBody>;
};

export type CallInfo = { client?: string; requestId: string };

const REPLAY_WARNING: Warning = {
  code: "IDEMPOTENT_REPLAY",
  severity: "info",
  message: "Same idempotencyKey as an earlier executed call: this is its stored result; nothing ran again.",
};

const safeText = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

/** Maps the offer-lifecycle service failures to MCP errors. */
export function lifecycleToolError(failure: OfferLifecycleFailure, refForAction?: string): ToolError {
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", "Offer not found in that shop.");
    case "validation":
      return new ToolError("VALIDATION", safeText(failure.error), failure.capacity ? { details: { capacity: failure.capacity } } : {});
    case "state":
      return new ToolError(failure.reason === "stale" ? "STATE_CONFLICT" : "INVALID_STATE", safeText(failure.error));
    case "publish_failed":
      return new ToolError(
        "PUBLISH_FAILED",
        failure.rolledBack
          ? `Publishing to Shopify failed and the change was rolled back (${safeText(failure.error)}).`
          : `The change was saved but publishing to Shopify failed (${safeText(failure.error)}). The offer may have been paused so the shop stays consistent.`,
        {
          ...(failure.capacity ? { details: { capacity: failure.capacity } } : {}),
          suggestedAction: refForAction
            ? { mcp: "promo-engine", tool: "promo_detail", args: { ref: refForAction }, why: "Check the offer's current status and publish errors, then retry." }
            : { mcp: "promo-engine", tool: "promo_health", args: {}, why: "Check publish errors, then retry." },
        },
      );
  }
}

/**
 * The shared write path (owner 2026-11-13, full access): rate limit, then either an optional dry run (preview only)
 * or a direct execute that claims a row in mcp_call_log, runs the service and stores the result for idempotent
 * replay. Every outcome is logged and audited.
 */
export async function runWrite(ctx: McpContext, call: CallInfo, spec: WriteSpec): Promise<CallToolResult> {
  const started = performance.now();
  const shopDomains = spec.shops.map((s) => s.myshopifyDomain);
  let claimId: string | null = null;
  try {
    const result = await runInner(ctx, call, spec, (id) => {
      claimId = id;
    });
    const outcome = result.replayed ? "replay" : "ok";
    if (claimId) await finishWrite(ctx.db, claimId, outcome, performance.now() - started, { argsHash: hashArgs(spec.args), result: result.value });
    else await logCall(ctx.db, { operatorId: ctx.operator.id, tool: spec.tool, shops: shopDomains, args: spec.args, outcome, durationMs: performance.now() - started });
    return toCallToolResult(result.value);
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const outcome = outcomeOf(response);
    const duration = performance.now() - started;
    if (claimId) await finishWrite(ctx.db, claimId, outcome, duration, null).catch(() => undefined);
    else await logCall(ctx.db, { operatorId: ctx.operator.id, tool: spec.tool, shops: shopDomains.length ? shopDomains : shopsFromArgs(spec.args), args: spec.args, outcome, durationMs: duration });
    return response;
  }
}

async function runInner(
  ctx: McpContext,
  call: CallInfo,
  spec: WriteSpec,
  onClaim: (id: string) => void,
): Promise<{ value: ToolResult<unknown>; replayed: boolean }> {
  // Owner 2026-11-13: no roles, no per-shop write lock, no mandatory dry run. dryRun:true is an optional preview.
  await enforceOperatorRate(ctx, "write");
  if (spec.dryRun) {
    const preview = await spec.preview();
    return {
      replayed: false,
      value: buildResult(
        {
          summary: `DRY RUN, nothing changed. ${preview.summary}
Call ${spec.tool} again without dryRun to apply.`,
          data: preview.data,
          links: preview.links,
          warnings: preview.warnings,
          nextActions: [
            ...(preview.nextActions ?? []),
            { mcp: "promo-engine", tool: spec.tool, args: { ...withoutControls(spec.args), dryRun: false }, why: "Apply the previewed change." },
          ],
          meta: { dryRun: true },
        },
        ctx.now,
      ),
    };
  }

  const argsHash = hashArgs(spec.args);
  if (spec.idempotencyKey) {
    const earlier = await findIdempotent(ctx.db, ctx.operator.id, spec.tool, spec.idempotencyKey, ctx.now());
    if (earlier) return { value: replayOf(earlier, argsHash), replayed: true };
  }
  // A confirmToken from an older client is still honoured for its optimistic checks; it is never required.
  const primary = spec.shops[0];
  const verified =
    spec.confirmToken && primary
      ? verifyConfirmToken(ctx.env, spec.confirmToken, { tool: spec.tool, args: spec.args, operatorId: ctx.operator.id, shopDomain: primary.myshopifyDomain }, ctx.now())
      : { jti: randomUUID(), offerUpdatedAt: null, setHash: null };

  const claim = await claimWrite(ctx.db, {
    operatorId: ctx.operator.id,
    tool: spec.tool,
    shops: spec.shops.map((s) => s.myshopifyDomain),
    args: spec.args,
    jti: verified.jti,
    idempotencyKey: spec.idempotencyKey,
  });
  if (!claim.ok) {
    if (claim.reason === "jti") throw new ToolError("CONFIRM_INVALID", "This confirmToken was already used; call again without it.");
    const earlier = spec.idempotencyKey ? await findIdempotent(ctx.db, ctx.operator.id, spec.tool, spec.idempotencyKey, ctx.now()) : null;
    if (earlier?.stored) return { value: replayOf(earlier, argsHash), replayed: true };
    throw new ToolError("STATE_CONFLICT", "A call with this idempotencyKey is still running or did not finish; retry with a new key.");
  }
  onClaim(claim.id);

  const body = await runWithCapacitySource("mcp", true, () => spec.apply({
    expectedUpdatedAt: verified.offerUpdatedAt,
    expectedSetHash: verified.setHash,
    performedBy: `mcp:${ctx.operator.id}`,
    auditExtra: { _mcp: { operator: ctx.operator.id, client: call.client ?? null, tool: spec.tool, requestId: call.requestId } },
    publish: ctx.publish,
  }));
  return {
    replayed: false,
    value: buildResult(
      { summary: body.summary, data: body.data, links: body.links, warnings: body.warnings, nextActions: body.nextActions, meta: { dryRun: false } },
      ctx.now,
    ),
  };
}

function withoutControls(args: Record<string, unknown>): Record<string, unknown> {
  const { dryRun: _d, confirmToken: _c, idempotencyKey: _i, ...rest } = args;
  return rest;
}

function replayOf(earlier: { outcome: string; stored: StoredResult | null }, argsHash: string): ToolResult<unknown> {
  if (!earlier.stored) throw new ToolError("STATE_CONFLICT", "A call with this idempotencyKey is still running or did not finish; use a new key after a new dry run.");
  if (earlier.stored.argsHash !== argsHash) {
    throw new ToolError("VALIDATION", "This idempotencyKey was already used with different arguments.");
  }
  const stored = earlier.stored.result as ToolResult<unknown>;
  return { ...stored, warnings: [REPLAY_WARNING, ...stored.warnings] };
}
