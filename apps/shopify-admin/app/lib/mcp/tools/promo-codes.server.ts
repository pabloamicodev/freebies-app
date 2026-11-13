/**
 * MCP tools for discount codes (FIX-mcpfa-08): create a code offer (the Discount Codes wizard), add a code or batch,
 * discount message, redemption mode, retry original code, export. Business logic lives in lib/offer-codes.server.ts and
 * lib/offer-authoring/codes.ts, the same code the admin Codes tab and wizard run.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import { insertAuditLog } from "../../audit-log.server.js";
import { createCodeOffer, exportOfferCodesPage, runOfferCodesCommand, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT, type OfferCodesCommand, type OfferCodesFailure } from "../../offer-codes.server.js";
import { AuthoringCodeOfferSchema, codeSettingsShape, toCodeOfferDraft } from "../../offer-authoring/codes.js";
import { MAX_BATCH_SIZE, CODE_CHARSETS } from "../../discount-code-generation.js";
import type { AuthoringDeps } from "../../offer-authoring/types.js";
import type { OfferLifecycleFailure } from "../../offer-lifecycle.server.js";
import { parseLocalDateTimeInZone } from "../../offer-validation.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, promoRef, shopHandle, type ErrorCode, type ToolResult } from "../result.server.js";
import { runTool, toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

// Package 01 adds CAPACITY_LIMIT to ERROR_CODES; the cast keeps this file compiling before that merge.
const CAPACITY_LIMIT = "CAPACITY_LIMIT" as ErrorCode;

const controls = {
  dryRun: z.boolean().optional().describe("true previews the outcome (validation, counts) and writes nothing. Default false: executes."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

type Controls = { dryRun?: boolean; idempotencyKey?: string };

const safeText = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

function failureToError(failure: OfferCodesFailure, ref?: string): ToolError {
  if (failure.kind === "not_found") return new ToolError("NOT_FOUND", "Offer not found in that shop.");
  const suggestedAction = ref ? { mcp: "promo-engine" as const, tool: "promo_detail", args: { ref }, why: "Check the offer's current status and publish errors, then retry." } : undefined;
  if (failure.kind === "publish_failed") {
    return new ToolError("PUBLISH_FAILED", `The change was saved but publishing to Shopify failed (${safeText(failure.error)}). The offer may have been paused so the shop stays consistent.`, { suggestedAction });
  }
  return new ToolError(failure.capacity ? CAPACITY_LIMIT : "VALIDATION", safeText(failure.error), failure.capacity ? { details: { capacity: failure.capacity } } : {});
}

function lifecycleFailureToError(failure: OfferLifecycleFailure, saved?: { ref: string }): ToolError {
  const note = saved ? ` The offer ${saved.ref} was saved as a draft with its codes; fix the problem and activate it with promo_activate_draft.` : "";
  const suggestedAction = saved ? { mcp: "promo-engine" as const, tool: "promo_detail", args: { ref: saved.ref }, why: "Inspect the saved draft." } : undefined;
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", "Offer not found in that shop.");
    case "validation":
      return new ToolError(failure.capacity ? CAPACITY_LIMIT : "VALIDATION", safeText(failure.error) + note, { ...(failure.capacity ? { details: { capacity: failure.capacity } } : {}), suggestedAction });
    case "state":
      return new ToolError(failure.reason === "stale" ? "STATE_CONFLICT" : "INVALID_STATE", safeText(failure.error) + note, { suggestedAction });
    case "publish_failed":
      return new ToolError(failure.capacity ? CAPACITY_LIMIT : "PUBLISH_FAILED", `Publishing to Shopify failed (${safeText(failure.error)}) and the status was rolled back.${note}`, { ...(failure.capacity ? { details: { capacity: failure.capacity } } : {}), suggestedAction });
  }
}

type Built = {
  tool: string;
  shops: VisibleShop[];
  preview: () => Promise<WritePreview>;
  apply: (apply: ApplyContext) => Promise<WriteBody>;
};

async function guardedWrite(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  args: Controls & Record<string, unknown>,
  build: (visible: VisibleShop[]) => Promise<Built>,
): Promise<CallToolResult> {
  const started = performance.now();
  let built: Built;
  try {
    built = await build(await visibleShops(ctx.db, ctx.operator));
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  return runWrite(ctx, call, {
    tool: built.tool,
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: built.shops,
    preview: built.preview,
    apply: built.apply,
  });
}

const authoringDeps = (db: Db, shop: VisibleShop): AuthoringDeps => ({ db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode, timezone: shop.timezone });

async function offerRow(db: Db, shop: VisibleShop, offerId: string) {
  const [row] = await db
    .select({ name: offers.internalName, status: offers.status, updatedAt: offers.updatedAt, codeRedemption: offers.codeRedemption, publicTitle: offers.publicTitle })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)))
    .limit(1);
  if (!row) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  return row;
}

/** Shared shape of the offer-scoped code writes: resolve the ref, preview via the service's dryRun, apply, audit. */
function offerCodesWrite(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  args: Controls & { ref?: string; shop?: string },
  plan: (shop: VisibleShop, offerId: string) => { command: OfferCodesCommand; describe: string; auditAfter?: Record<string, unknown> },
  success: (result: Extract<Awaited<ReturnType<typeof runOfferCodesCommand>>, { ok: true }>, ref: string) => { summary: string; data: Record<string, unknown>; nextActions?: WriteBody["nextActions"] },
): Promise<CallToolResult> {
  return guardedWrite(ctx, call, tool, args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const { command, describe, auditAfter } = plan(shop, offerId);
    const deps = authoringDeps(ctx.db, shop);
    return {
      tool,
      shops: [shop],
      preview: async () => {
        const row = await offerRow(ctx.db, shop, offerId);
        const result = await runOfferCodesCommand(deps, offerId, command, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
        if (!result.ok) throw failureToError(result, ref);
        return {
          summary: `${describe} for "${row.name}" (${ref}, ${row.status}). ${result.message}${row.status === "active" ? " The offer is live, so the shop config is republished." : ""}`,
          data: { promoRef: ref, offerId, offerStatus: row.status },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: row.updatedAt,
        };
      },
      apply: async (a) => {
        const row = await offerRow(ctx.db, shop, offerId);
        if (a.expectedUpdatedAt && row.updatedAt.getTime() !== a.expectedUpdatedAt.getTime()) {
          throw new ToolError("STATE_CONFLICT", "The offer changed since the dry run; run it again.");
        }
        const result = await runOfferCodesCommand(deps, offerId, command, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish });
        if (!result.ok) throw failureToError(result, ref);
        await insertAuditLog(ctx.db, {
          shopId: shop.id,
          entityType: "offer",
          entityId: offerId,
          action: tool,
          after: { ...(auditAfter ?? {}), ...a.auditExtra },
          performedBy: a.performedBy,
        });
        const out = success(result, ref);
        return {
          summary: out.summary,
          data: out.data,
          warnings: result.warning ? [{ code: "CODE_WARNING", severity: "warn", message: result.warning }] : undefined,
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: out.nextActions ?? [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new state.", risk: "read" }],
        };
      },
    };
  });
}

// ---- promo_create_code_offer ----

export const promoCreateCodeOfferInput = {
  shop: z.string().max(200).describe("Shop domain or handle to create the offer in."),
  ...AuthoringCodeOfferSchema.shape,
  ...controls,
};

export async function promoCreateCodeOfferTool(ctx: McpContext, call: CallInfo, args: Controls & z.infer<typeof AuthoringCodeOfferSchema> & { shop: string }): Promise<CallToolResult> {
  return guardedWrite(ctx, call, "promo_create_code_offer", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const deps = authoringDeps(ctx.db, shop!);
    const { shop: _shop, dryRun: _d, idempotencyKey: _i, ...input } = args;
    const draft = toCodeOfferDraft(input, deps);
    if (!draft.ok) throw new ToolError("VALIDATION", safeText(draft.error));
    const what = `${draft.value.target} code offer "${draft.value.internalName}" (${draft.value.redemption === "automatic" ? "automatic" : draft.value.codes?.mode === "bulk" ? `${draft.value.codes.spec.count} generated codes` : "one typed code"}), status ${draft.value.status}`;
    return {
      tool: "promo_create_code_offer",
      shops: [shop!],
      preview: async () => {
        const result = await createCodeOffer(deps, draft.value, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
        if (!result.ok) throw new ToolError("VALIDATION", safeText(result.error));
        return {
          summary: `Create ${what} in ${shopHandle(shop!.myshopifyDomain)}; ${result.codesCreated} code(s) would be created.`,
          data: { shop: shop!.myshopifyDomain, status: draft.value.status, codesCreated: result.codesCreated },
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const result = await createCodeOffer(deps, draft.value, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish });
        if (!result.ok) throw new ToolError("VALIDATION", safeText(result.error));
        const ref = promoRef(shop!.myshopifyDomain, result.offerId);
        if (result.activationFailure) throw lifecycleFailureToError(result.activationFailure, { ref });
        await insertAuditLog(ctx.db, {
          shopId: shop!.id,
          entityType: "offer",
          entityId: result.offerId,
          action: "promo_create_code_offer",
          after: { status: result.status, codesCreated: result.codesCreated, target: draft.value.target, redemption: draft.value.redemption, ...a.auditExtra },
          performedBy: a.performedBy,
        });
        const batch = draft.value.codes?.mode === "bulk";
        return {
          summary: `Created ${what} as ${ref}: status ${result.status}, ${result.codesCreated} code(s).`,
          data: { promoRef: ref, offerId: result.offerId, status: result.status, codesCreated: result.codesCreated },
          warnings: (result.warnings ?? []).map((message) => ({ code: "PUBLISH_ADVISORY", severity: "warn" as const, message })),
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          nextActions: batch
            ? [{ mcp: "promo-engine", tool: "codes_export", args: { ref }, why: "Download the generated codes (unmasked CSV).", risk: "read" }]
            : [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new offer.", risk: "read" }],
        };
      },
    };
  });
}

// ---- codes_add ----

export const codesAddInput = {
  ...refFields,
  code: z.string().trim().min(1).max(255).optional().describe("One typed code, e.g. 'SUMMER10' (letters, digits, '-' and '_'; stored upper-case). Exactly one of code / batch."),
  batch: z
    .strictObject({
      count: z.number().int().min(1).max(MAX_BATCH_SIZE).describe(`How many codes to generate (1-${MAX_BATCH_SIZE} per call).`),
      prefix: z.string().trim().max(40).optional().describe("Optional prefix such as 'VIP-' (upper-cased; A-Z, 0-9, '-', '_' kept)."),
      length: z.number().int().min(4).max(32).optional().describe("Random part length 4-32 (default 8); too short a space is refused."),
      charset: z.enum(Object.keys(CODE_CHARSETS) as [keyof typeof CODE_CHARSETS, ...(keyof typeof CODE_CHARSETS)[]]).optional().describe("unambiguous (default), alphanumeric, letters or numbers."),
    })
    .optional()
    .describe("Generate unique codes: { count: 100, prefix: 'VIP-' }."),
  ...codeSettingsShape,
  ...controls,
};

const parseCodeWindow = (raw: string | undefined, timezone: string, field: string): Date | null => {
  if (!raw) return null;
  const date = parseLocalDateTimeInZone(raw, timezone);
  if (!date) throw new ToolError("VALIDATION", `${field} is not a valid date.`);
  return date;
};

export function codesAddTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string; code?: string; batch?: { count: number; prefix?: string; length?: number; charset?: keyof typeof CODE_CHARSETS }; usageLimit?: number; oncePerCustomer?: boolean; codeStartsAt?: string; codeEndsAt?: string }): Promise<CallToolResult> {
  if (Boolean(args.code) === Boolean(args.batch)) {
    return Promise.resolve(toErrorCallToolResult(new ToolError("VALIDATION", "Pass exactly one of code or batch.")));
  }
  return offerCodesWrite(
    ctx,
    call,
    "codes_add",
    args,
    (shop) => {
      const settings = {
        startsAt: parseCodeWindow(args.codeStartsAt, shop.timezone, "codeStartsAt"),
        endsAt: parseCodeWindow(args.codeEndsAt, shop.timezone, "codeEndsAt"),
        usageLimit: args.usageLimit ?? null,
        oncePerCustomer: args.oncePerCustomer ?? false,
      };
      if (args.batch) {
        const spec = { prefix: args.batch.prefix ?? "", length: args.batch.length ?? 8, charset: args.batch.charset ?? "unambiguous", count: args.batch.count };
        return { command: { intent: "generate_batch", spec, settings }, describe: `Generate ${spec.count} code(s)`, auditAfter: { count: spec.count, length: spec.length } };
      }
      return { command: { intent: "add_code", code: args.code, settings }, describe: "Add one code", auditAfter: { typed: true } };
    },
    (result, ref) =>
      result.batchId
        ? {
            summary: `Generated ${result.created} code(s) for ${ref} (batch ${result.batchId}).`,
            data: { promoRef: ref, batchId: result.batchId, created: result.created },
            nextActions: [{ mcp: "promo-engine", tool: "codes_export", args: { ref, batchId: result.batchId }, why: "Download the generated codes (unmasked CSV).", risk: "read" }],
          }
        : { summary: `Added code ${result.code?.code} to ${ref}.`, data: { promoRef: ref, codeId: result.code?.id, code: result.code?.code } },
  );
}

// ---- codes_set_discount_message / codes_set_redemption_mode / codes_retry_original ----

export const codesSetDiscountMessageInput = {
  ...refFields,
  message: z.string().max(200).describe("Message customers see at checkout, max 60 characters after trimming; empty falls back to the offer's internal name."),
  ...controls,
};
export function codesSetDiscountMessageTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string; message: string }): Promise<CallToolResult> {
  return offerCodesWrite(
    ctx,
    call,
    "codes_set_discount_message",
    args,
    () => ({ command: { intent: "set_discount_message", message: args.message }, describe: "Set the discount message", auditAfter: { message: args.message } }),
    (_result, ref) => ({ summary: `Discount message of ${ref} set to "${args.message.trim()}".`, data: { promoRef: ref, message: args.message.trim() } }),
  );
}

export const codesSetRedemptionModeInput = {
  ...refFields,
  mode: z.enum(["checkout_code", "automatic"]).describe("checkout_code: customers enter a code. automatic: the offer applies on its conditions alone and its codes are paused (needs at least one enabled main condition; subject to the shop's automatic-discount capacity)."),
  ...controls,
};
export function codesSetRedemptionModeTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string; mode: "checkout_code" | "automatic" }): Promise<CallToolResult> {
  return offerCodesWrite(
    ctx,
    call,
    "codes_set_redemption_mode",
    args,
    () => ({ command: { intent: "set_redemption_mode", mode: args.mode }, describe: `Set redemption to ${args.mode}`, auditAfter: { mode: args.mode } }),
    (result, ref) => ({ summary: `${ref}: ${result.message}`, data: { promoRef: ref, mode: args.mode, unchanged: result.message === "Already set." } }),
  );
}

export const codesRetryOriginalInput = {
  ...refFields,
  codeId: z.string().uuid().describe("Id of the code (from codes_list) that was suffixed after a collision with a code already on Shopify."),
  ...controls,
};
export function codesRetryOriginalTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string; codeId: string }): Promise<CallToolResult> {
  return offerCodesWrite(
    ctx,
    call,
    "codes_retry_original",
    args,
    () => ({ command: { intent: "retry_original", codeId: args.codeId }, describe: "Switch a suffixed code back to its original", auditAfter: { codeId: args.codeId } }),
    (result, ref) => ({ summary: `${ref}: ${result.message}`, data: { promoRef: ref, codeId: args.codeId } }),
  );
}

// ---- codes_export ----

export const codesExportInput = {
  ...refFields,
  status: z.enum(["active", "disabled", "exhausted"]).optional().describe("Only codes in this status."),
  batchId: z.string().uuid().optional().describe("Only the codes of this batch (from codes_add / codes_list)."),
  search: z.string().trim().max(100).optional().describe("Substring of the code."),
  limit: z.number().int().min(1).max(EXPORT_MAX_LIMIT).optional().describe(`Rows per call, 1-${EXPORT_MAX_LIMIT} (default ${EXPORT_DEFAULT_LIMIT}). Bigger sets are paged: pass meta.page.cursor back as cursor.`),
  cursor: z.string().optional().describe("meta.page.cursor of the previous call."),
};

const cursorOffset = (cursor?: string): number => {
  if (!cursor) return 0;
  try {
    const value = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  } catch {
    /* falls through */
  }
  throw new ToolError("VALIDATION", "Invalid cursor: use meta.page.cursor from the previous response.");
};

/**
 * Codes UNMASKED (owner decision A8: the admin Codes tab exports them too; codes_list stays masked). `csv` is byte-for-byte
 * what GET /api/offers/:id/codes/export returns for the same filter (header line first); `rows` is the same data structured.
 * One call returns at most 2000 codes; page with the cursor and drop the header line of every page after the first.
 */
export async function codesExport(ctx: McpContext, args: { ref?: string; shop?: string; status?: "active" | "disabled" | "exhausted"; batchId?: string; search?: string; limit?: number; cursor?: string }): Promise<ToolResult<unknown>> {
  const { shop, offerId } = resolvePromoRef(await visibleShops(ctx.db, ctx.operator), args);
  const ref = promoRef(shop.myshopifyDomain, offerId);
  await offerRow(ctx.db, shop, offerId);
  const offset = cursorOffset(args.cursor);
  const page = await exportOfferCodesPage(ctx.db, shop.id, offerId, { status: args.status, batchId: args.batchId, search: args.search, limit: args.limit, offset });
  const nextCursor = page.nextOffset === null ? undefined : Buffer.from(JSON.stringify({ o: page.nextOffset }), "utf8").toString("base64url");
  return buildResult(
    {
      summary: `${page.rows.length} of ${page.total} code(s) of ${ref} (UNMASKED: treat as secret).${nextCursor ? " More pages: pass meta.page.cursor as cursor." : ""}`,
      data: {
        promoRef: ref,
        offerId,
        total: page.total,
        returned: page.rows.length,
        csv: page.csv,
        rows: page.rows.map((row) => ({
          code: row.code,
          status: row.status,
          startsAt: row.startsAt?.toISOString() ?? null,
          endsAt: row.endsAt?.toISOString() ?? null,
          usageLimit: row.usageLimit,
          oncePerCustomer: row.oncePerCustomer,
          usageCount: row.usageCount,
          batchId: row.batchId,
        })),
      },
      links: [adminLink(shopHandle(shop.myshopifyDomain))],
      warnings: [{ code: "UNMASKED_CODES", severity: "info", message: "These are real redeemable codes; do not paste them anywhere public." }],
      meta: { page: { hasMore: Boolean(nextCursor), ...(nextCursor ? { cursor: nextCursor } : {}) } },
    },
    ctx.now,
  );
}

export const runCodesExport = (ctx: McpContext, args: Parameters<typeof codesExport>[1]) => runTool(() => codesExport(ctx, args));
