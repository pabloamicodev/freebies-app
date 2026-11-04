import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { discountCodes, offers, type Db } from "@promo/db";
import { requireRole, type McpRole } from "../auth.server.js";
import { insertAuditLog } from "../../audit-log.server.js";
import { duplicateOffer } from "../../offer-duplicate.server.js";
import { setDiscountCodesStatus } from "../../discount-codes.server.js";
import { republishIfActive, tryPublishShop } from "../../offer-publish-flow.server.js";
import {
  archiveOffer,
  pauseOffer,
  republishShop,
  resumeOffer,
  setOfferPageUrls,
  setOfferSchedule,
  type OfferLifecycleResult,
  type OfferLifecycleSuccess,
} from "../../offer-lifecycle.server.js";
import { sharedConfigBreakdown } from "../../shared-config-size.server.js";
import { MAX_METAFIELD_BYTES } from "../../sync/offer-publisher.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, promoRef, publishAdvisories, shopHandle, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, lifecycleToolError, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

export const writeControls = {
  dryRun: z
    .boolean()
    .optional()
    .describe("Default true: previews the change and returns a confirmToken, nothing is written. false executes and needs that confirmToken."),
  confirmToken: z.string().max(2000).optional().describe("From the dry run of this exact call; valid 5 minutes, single use."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};
const reason = z.string().trim().min(3).max(300);
const url = z.string().trim().max(300);

export const promoPauseInput = { ...refFields, reason: reason.describe("Why (stored in the audit log)."), ...writeControls };
export const promoResumeInput = { ...refFields, ...writeControls };
export const promoArchiveInput = { ...refFields, reason: reason.optional().describe("Why (stored in the audit log)."), ...writeControls };
export const promosRepublishShopInput = { shop: z.string().max(200).describe("Shop domain or handle."), ...writeControls };
export const promoDuplicateInput = {
  ...refFields,
  name: z.string().trim().min(1).max(120).optional().describe("Name of the draft copy; made unique in the target shop. Default: '<name>-copy'."),
  targetShop: z.string().max(200).optional().describe("Must be the source shop (or omitted): cross-shop copies are not supported yet because product and collection ids can't be translated."),
  ...writeControls,
};
export const promoCreateDraftInput = {
  shop: z.string().max(200).describe("Shop that owns the template offer and receives the draft."),
  templateId: z.string().max(200).describe("The template offer: its offerId or promo:<shopHandle>:<offerId>."),
  name: z.string().trim().min(1).max(120).describe("Name of the new draft; made unique in the shop."),
  overrides: z
    .strictObject({
      startsAt: z.string().trim().max(40).nullable().optional().describe("Shop-local 'YYYY-MM-DDTHH:mm' (or an ISO instant); null clears."),
      endsAt: z.string().trim().max(40).nullable().optional(),
      excludeUrls: z.array(url).max(100).optional(),
      pageUrls: z.array(url).max(50).optional(),
    })
    .optional()
    .describe("Bounded changes applied to the draft: schedule and Store pages URLs only."),
  ...writeControls,
};
export const promoSetPageExcludeUrlsInput = {
  ...refFields,
  excludeUrls: z.array(url).max(100).describe("Replaces the Store pages exclude list (max 100 paths of 300 chars); [] clears it."),
  pageUrls: z.array(url).max(50).optional().describe("Optional: replaces the specific page paths (needs the Pages kind selected)."),
  ...writeControls,
};
export const promoSetScheduleInput = {
  ...refFields,
  startsAt: z.string().trim().max(40).nullable().optional().describe("Shop-local 'YYYY-MM-DDTHH:mm' (or an ISO instant); null clears; omitted keeps."),
  endsAt: z.string().trim().max(40).nullable().optional(),
  ...writeControls,
};
export const MAX_CODES_PER_CALL = 2000;
export const codesSetStatusInput = {
  ...refFields,
  status: z.enum(["active", "disabled"]),
  ids: z.array(z.string().uuid()).min(1).max(MAX_CODES_PER_CALL).optional().describe("Specific code ids (from codes_list)."),
  batchId: z.string().uuid().optional(),
  all: z.boolean().optional().describe("Every code of the offer."),
  ...writeControls,
};

export type Controls = { dryRun?: boolean; confirmToken?: string; idempotencyKey?: string };
type Built = {
  tool: string;
  minRole: McpRole;
  critical: boolean;
  shops: VisibleShop[];
  preview: () => Promise<WritePreview>;
  apply: (apply: ApplyContext) => Promise<WriteBody>;
};

/** Resolves refs/shops (any failure is logged and returned as a tool error), then hands the spec to runWrite. */
export async function guarded(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  minRole: McpRole,
  args: Controls & Record<string, unknown>,
  build: (visible: VisibleShop[]) => Promise<Built>,
): Promise<CallToolResult> {
  const started = performance.now();
  let built: Built;
  try {
    requireRole(ctx.operator, minRole);
    built = await build(await visibleShops(ctx.db, ctx.operator));
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  return runWrite(ctx, call, {
    tool: built.tool,
    minRole: built.minRole,
    critical: built.critical,
    args,
    dryRun: args.dryRun !== false,
    confirmToken: args.confirmToken,
    idempotencyKey: args.idempotencyKey,
    shops: built.shops,
    preview: built.preview,
    apply: built.apply,
  });
}

export async function offerBasics(db: Db, shop: VisibleShop, offerId: string) {
  const [row] = await db
    .select({ name: offers.internalName, status: offers.status, updatedAt: offers.updatedAt, type: offers.type })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)))
    .limit(1);
  if (!row) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  return row;
}

const withReason = (a: ApplyContext, why?: string) => (why ? { _mcp: { ...(a.auditExtra["_mcp"] as object), reason: why } } : a.auditExtra);
/** Offer names come from the shop: one short line, so they read as data inside a summary, never as instructions. */
export const label = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 80);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function expectOk(result: OfferLifecycleResult, ref: string): OfferLifecycleSuccess {
  if (!result.ok) throw lifecycleToolError(result, ref);
  return result;
}

export function plain(details: Record<string, unknown> | undefined): Record<string, unknown> {
  return JSON.parse(JSON.stringify(details ?? {})) as Record<string, unknown>;
}

type StatusTool = {
  tool: "promo_pause" | "promo_resume" | "promo_archive";
  minRole: McpRole;
  critical: boolean;
  run: typeof pauseOffer;
  verb: string;
  hasReason: boolean;
};

const STATUS_TOOLS: Record<StatusTool["tool"], StatusTool> = {
  promo_pause: { tool: "promo_pause", minRole: "editor", critical: false, run: pauseOffer, verb: "Pause", hasReason: true },
  promo_resume: { tool: "promo_resume", minRole: "editor", critical: false, run: resumeOffer, verb: "Resume", hasReason: false },
  promo_archive: { tool: "promo_archive", minRole: "admin", critical: true, run: archiveOffer, verb: "Archive", hasReason: true },
};

export function statusChange(
  ctx: McpContext,
  call: CallInfo,
  which: StatusTool["tool"],
  args: Controls & { ref?: string; shop?: string; reason?: string },
): Promise<CallToolResult> {
  const def = STATUS_TOOLS[which];
  return guarded(ctx, call, def.tool, def.minRole, args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const lifecycle = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId };
    return {
      tool: def.tool,
      minRole: def.minRole,
      critical: def.critical,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const result = expectOk(await def.run(ctx.db, lifecycle, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        return {
          summary: `${def.verb} "${label(basics.name)}" (${ref}): ${result.statusBefore} -> ${result.statusAfter}. The shop's Shopify config is republished and rolled back if that fails.`,
          data: { promoRef: ref, offerId, name: basics.name, statusBefore: result.statusBefore, statusAfter: result.statusAfter, willPublish: true },
          warnings: publishAdvisories(result.warnings),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: result.updatedAt,
        };
      },
      apply: async (a) => {
        const result = expectOk(
          await def.run(ctx.db, lifecycle, {
            performedBy: a.performedBy,
            auditExtra: withReason(a, def.hasReason ? args.reason : undefined),
            publish: a.publish,
            expectedUpdatedAt: a.expectedUpdatedAt ?? undefined,
          }),
          ref,
        );
        return {
          summary: `${def.verb}d ${ref}: ${result.statusBefore} -> ${result.statusAfter}. Shopify config republished.`,
          data: { promoRef: ref, offerId, statusBefore: result.statusBefore, statusAfter: result.statusAfter },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new state.", risk: "read" }],
        };
      },
    };
  });
}

export function republishShopTool(ctx: McpContext, call: CallInfo, args: Controls & { shop: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "promos_republish_shop", "admin", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    return {
      tool: "promos_republish_shop",
      minRole: "admin",
      critical: false,
      shops: [shop!],
      preview: async () => {
        const warnings: Warning[] = [];
        const live = await ctx.db
          .select({ id: offers.id })
          .from(offers)
          .where(and(eq(offers.shopId, shop!.id), inArray(offers.status, ["active", "scheduled"])));
        let capacity: { bytesUsed: number; limit: number; pct: number } | null = null;
        try {
          const breakdown = await sharedConfigBreakdown(ctx.db, shop!.id, shop!.currencyCode);
          capacity = { bytesUsed: breakdown.totalBytes, limit: MAX_METAFIELD_BYTES, pct: Math.round((breakdown.totalBytes / MAX_METAFIELD_BYTES) * 1000) / 10 };
          if (breakdown.totalBytes > MAX_METAFIELD_BYTES) {
            warnings.push({ code: "CAPACITY_EXCEEDED", severity: "block", message: "The shared config is over the metafield limit: this publish would fail." });
          }
        } catch {
          warnings.push({ code: "CAPACITY_UNKNOWN", severity: "warn", message: "Could not estimate the config size; the publish may still fail." });
        }
        return {
          summary: `Republish the Shopify config of ${shop!.myshopifyDomain}: ${live.length} live/scheduled offer(s), no offer is modified.`,
          data: { shopDomain: shop!.myshopifyDomain, liveOffers: live.length, capacity },
          warnings,
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const result = await republishShop(ctx.db, { shopId: shop!.id, shopDomain: shop!.myshopifyDomain }, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish });
        if (!result.ok) throw lifecycleToolError({ ...result, statusBefore: "active", statusAfter: "active" });
        return {
          summary: `Republished the Shopify config of ${shop!.myshopifyDomain}.`,
          data: { shopDomain: shop!.myshopifyDomain },
          nextActions: [{ mcp: "promo-engine", tool: "promo_health", args: { shops: [shop!.myshopifyDomain] }, why: "Confirm there are no publish errors.", risk: "read" }],
        };
      },
    };
  });
}

/** `name`, then `name (2)`, `name (3)`... until the (shop, internal_name) unique key is free. */
export async function uniqueOfferName(db: Db, shopId: string, desired: string): Promise<string> {
  const base = desired.slice(0, 120);
  const taken = new Set(
    (await db.select({ name: offers.internalName }).from(offers).where(and(eq(offers.shopId, shopId), like(offers.internalName, `${base.replace(/[\\%_]/g, "\\$&")}%`)))).map((r) => r.name),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 120 - ` (${n})`.length)} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ToolError("VALIDATION", "Could not find a free name; pass a different name.");
}

const isUnique = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === "23505" || x?.cause?.code === "23505";
};

async function cloneDraft(
  ctx: McpContext,
  a: ApplyContext,
  source: { shop: VisibleShop; offerId: string },
  target: VisibleShop,
  name: string,
  tool: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const current = await offerBasics(ctx.db, source.shop, source.offerId);
  if (a.expectedUpdatedAt && current.updatedAt.getTime() !== a.expectedUpdatedAt.getTime()) {
    throw new ToolError("STATE_CONFLICT", "The source offer changed since the dry run; run it again.");
  }
  const finalName = await uniqueOfferName(ctx.db, target.id, name);
  let newId: string | null;
  try {
    newId = await duplicateOffer(ctx.db, source.shop.id, source.offerId, { name: finalName });
  } catch (error) {
    if (isUnique(error)) throw new ToolError("STATE_CONFLICT", "The name was taken meanwhile; run the dry run again.");
    throw error;
  }
  if (!newId) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  await insertAuditLog(ctx.db, {
    shopId: target.id,
    entityType: "offer",
    entityId: newId,
    action: tool === "promo_duplicate" ? "duplicate" : "create_draft_from_template",
    before: { sourceOfferId: source.offerId, sourceShop: source.shop.myshopifyDomain },
    after: { status: "draft", name: finalName, ...extra, ...a.auditExtra },
    performedBy: a.performedBy,
  });
  return newId;
}

export function duplicateTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; name?: string; targetShop?: string },
): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_duplicate", "editor", args, async (visible) => {
    const source = resolvePromoRef(visible, args);
    const target = args.targetShop ? selectShops(visible, [args.targetShop])[0]! : source.shop;
    if (target.id !== source.shop.id) {
      throw new ToolError("VALIDATION", "Cross-shop copies are not supported yet: product, variant and collection ids can't be translated across shops. Duplicate inside the same shop.");
    }
    const sourceRef = promoRef(source.shop.myshopifyDomain, source.offerId);
    return {
      tool: "promo_duplicate",
      minRole: "editor",
      critical: false,
      shops: [source.shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, source.shop, source.offerId);
        const name = await uniqueOfferName(ctx.db, target.id, args.name ?? `${basics.name}-copy`);
        const warnings: Warning[] = [
          { code: "NOT_COPIED", severity: "info", message: "Discount codes, widgets, versions, usage counters and gift clone products are not copied; the copy is a draft." },
        ];
        return {
          summary: `Duplicate "${label(basics.name)}" (${basics.status}) as the draft "${name}" in ${target.myshopifyDomain}.`,
          data: { sourceRef, targetShop: target.myshopifyDomain, name, resultingStatus: "draft" },
          warnings,
          links: [adminLink(shopHandle(target.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const basics = await offerBasics(ctx.db, source.shop, source.offerId);
        const newId = await cloneDraft(ctx, a, source, target, args.name ?? `${basics.name}-copy`, "promo_duplicate", {});
        const newRef = promoRef(target.myshopifyDomain, newId);
        return {
          summary: `Created the draft ${newRef} from ${sourceRef}.`,
          data: { promoRef: newRef, offerId: newId, sourceRef, status: "draft" },
          links: [adminLink(shopHandle(target.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref: newRef }, why: "Review the draft.", risk: "read" }],
        };
      },
    };
  });
}

type Overrides = { startsAt?: string | null; endsAt?: string | null; excludeUrls?: string[]; pageUrls?: string[] };

export function createDraftFromTemplateTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string; templateId: string; name: string; overrides?: Overrides },
): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_create_draft_from_template", "editor", args, async (visible) => {
    const source = args.templateId.startsWith("promo:")
      ? resolvePromoRef(visible, { ref: args.templateId })
      : resolvePromoRef(visible, { offerId: args.templateId, shop: args.shop });
    const [shop] = selectShops(visible, [args.shop]);
    if (shop!.id !== source.shop.id) throw new ToolError("VALIDATION", "The template must belong to `shop`: v1 clones within one shop.");
    const o = args.overrides ?? {};
    const hasSchedule = o.startsAt !== undefined || o.endsAt !== undefined;
    const hasUrls = o.excludeUrls !== undefined || o.pageUrls !== undefined;
    const lifecycle = { shopId: shop!.id, shopDomain: shop!.myshopifyDomain, offerId: source.offerId };

    return {
      tool: "promo_create_draft_from_template",
      minRole: "editor",
      critical: false,
      shops: [shop!],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop!, source.offerId);
        const name = await uniqueOfferName(ctx.db, shop!.id, args.name);
        const probe = { performedBy: `mcp:${ctx.operator.id}`, dryRun: true } as const;
        // The overrides are validated against the template itself, so a bad override fails before anything is created.
        let schedule: Record<string, unknown> | undefined;
        let urls: Record<string, unknown> | undefined;
        if (hasSchedule) {
          schedule = plain(expectOk(await setOfferSchedule(ctx.db, { ...lifecycle, startsAt: o.startsAt, endsAt: o.endsAt, shopTimezone: shop!.timezone }, probe), "template").details);
        }
        if (hasUrls) {
          urls = plain(expectOk(await setOfferPageUrls(ctx.db, { ...lifecycle, excludeUrls: o.excludeUrls, pageUrls: o.pageUrls }, probe), "template").details);
        }
        return {
          summary: `Create the draft "${name}" in ${shop!.myshopifyDomain} as a copy of the template "${label(basics.name)}"${hasSchedule || hasUrls ? " with the given overrides" : ""}.`,
          data: { templateRef: promoRef(shop!.myshopifyDomain, source.offerId), name, resultingStatus: "draft", overrides: { schedule: schedule ?? null, pageUrls: urls ?? null } },
          warnings: [{ code: "NOT_COPIED", severity: "info", message: "Discount codes, widgets, versions and usage counters are not copied; the result is a draft." }],
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const newId = await cloneDraft(ctx, a, source, shop!, args.name, "promo_create_draft_from_template", { overrides: o });
        const newRef = promoRef(shop!.myshopifyDomain, newId);
        const copy = { shopId: shop!.id, shopDomain: shop!.myshopifyDomain, offerId: newId };
        const opts = { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish };
        // The draft already exists: a failing override is reported as a warning on a successful result, so the stored
        // outcome (and an idempotent retry) points at that draft instead of creating a second one.
        let overrideFailure: { step: string; code: string; message: string } | null = null;
        const check = (step: string, result: OfferLifecycleResult) => {
          if (result.ok) return;
          const e = lifecycleToolError(result, newRef);
          overrideFailure = { step, code: e.payload.code, message: e.payload.message };
        };
        if (hasSchedule) check("schedule", await setOfferSchedule(ctx.db, { ...copy, startsAt: o.startsAt, endsAt: o.endsAt, shopTimezone: shop!.timezone }, opts));
        if (hasUrls && !overrideFailure) check("pageUrls", await setOfferPageUrls(ctx.db, { ...copy, excludeUrls: o.excludeUrls, pageUrls: o.pageUrls }, opts));
        const failure = overrideFailure as { step: string; code: string; message: string } | null;
        return {
          summary: failure
            ? `Created the draft ${newRef}, but the ${failure.step} override failed (${failure.code}: ${failure.message}). Fix it on the draft with the matching tool.`
            : `Created the draft ${newRef} from the template.`,
          data: { promoRef: newRef, offerId: newId, status: "draft", overridesApplied: !failure, ...(failure ? { overrideFailure: failure } : {}) },
          warnings: failure ? [{ code: "OVERRIDE_FAILED", severity: "warn", message: `${failure.step}: ${failure.message}` }] : [],
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref: newRef }, why: "Review the draft.", risk: "read" }],
        };
      },
    };
  });
}

export function setPageExcludeUrlsTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; excludeUrls: string[]; pageUrls?: string[] },
): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_set_page_exclude_urls", "editor", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const input = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId, excludeUrls: args.excludeUrls, pageUrls: args.pageUrls };
    return {
      tool: "promo_set_page_exclude_urls",
      minRole: "editor",
      critical: false,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const result = expectOk(await setOfferPageUrls(ctx.db, input, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        return {
          summary: `Set the Store pages URLs of "${label(basics.name)}" (${ref}, ${basics.status})${basics.status === "active" ? "; it is live, so the shop config is republished" : ""}.`,
          data: { promoRef: ref, offerId, status: basics.status, ...plain(result.details) },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: result.updatedAt,
        };
      },
      apply: async (a) => {
        const result = expectOk(
          await setOfferPageUrls(ctx.db, input, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }),
          ref,
        );
        return {
          summary: `Updated the Store pages URLs of ${ref}.`,
          data: { promoRef: ref, offerId, ...plain(result.details) },
          nextActions: [{ mcp: "promo-engine", tool: "page_conditions_explain", args: { ref }, why: "Check how the offer now behaves on a page.", risk: "read" }],
        };
      },
    };
  });
}

export function setScheduleTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; startsAt?: string | null; endsAt?: string | null },
): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_set_schedule", "editor", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    if (args.startsAt === undefined && args.endsAt === undefined) {
      throw new ToolError("VALIDATION", "Pass startsAt and/or endsAt (null clears one).");
    }
    const input = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId, startsAt: args.startsAt, endsAt: args.endsAt, shopTimezone: shop.timezone };
    const serialize = (result: OfferLifecycleSuccess) => {
      const d = (result.details ?? {}) as { startsAt?: Date | null; endsAt?: Date | null; timezone?: string };
      return { promoRef: ref, offerId, statusBefore: result.statusBefore, statusAfter: result.statusAfter, startsAt: iso(d.startsAt), endsAt: iso(d.endsAt), timezone: d.timezone ?? null };
    };
    return {
      tool: "promo_set_schedule",
      minRole: "editor",
      critical: false,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const result = expectOk(await setOfferSchedule(ctx.db, input, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        const data = serialize(result);
        return {
          summary: `Reschedule "${label(basics.name)}" (${ref}): ${data.startsAt ?? "no start"} -> ${data.endsAt ?? "no end"} (${data.timezone}); status ${result.statusBefore} -> ${result.statusAfter}.`,
          data,
          warnings: publishAdvisories(result.warnings),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: result.updatedAt,
        };
      },
      apply: async (a) => {
        const result = expectOk(
          await setOfferSchedule(ctx.db, input, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }),
          ref,
        );
        return {
          summary: `Rescheduled ${ref}; status ${result.statusBefore} -> ${result.statusAfter}.`,
          data: serialize(result),
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the schedule.", risk: "read" }],
        };
      },
    };
  });
}

export function codesSetStatusTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; status: "active" | "disabled"; ids?: string[]; batchId?: string; all?: boolean },
): Promise<CallToolResult> {
  return guarded(ctx, call, "codes_set_status", "editor", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const targets = [args.ids ? 1 : 0, args.batchId ? 1 : 0, args.all ? 1 : 0].reduce((a, b) => a + b, 0);
    if (targets !== 1) throw new ToolError("VALIDATION", "Pass exactly one of ids, batchId or all.");
    const target = args.ids ? { ids: args.ids } : args.batchId ? { batchId: args.batchId } : { all: true };

    const scope = () => {
      const filters = [eq(discountCodes.shopId, shop.id), eq(discountCodes.offerId, offerId), ne(discountCodes.status, "exhausted")];
      if (target.ids) filters.push(inArray(discountCodes.id, target.ids));
      else if (target.batchId) filters.push(eq(discountCodes.batchId, target.batchId));
      return and(...filters);
    };
    const affected = async (exec: Db = ctx.db) => {
      const rows = await exec.select({ id: discountCodes.id, status: discountCodes.status }).from(discountCodes).where(scope()).limit(MAX_CODES_PER_CALL + 1);
      if (rows.length > MAX_CODES_PER_CALL) {
        throw new ToolError("VALIDATION", `More than ${MAX_CODES_PER_CALL} codes match; narrow it with a batchId or ids.`);
      }
      return rows.filter((r) => r.status !== args.status);
    };

    return {
      tool: "codes_set_status",
      minRole: "editor",
      critical: false,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const changing = await affected();
        return {
          summary: `Set ${changing.length} code(s) of "${label(basics.name)}" (${ref}) to ${args.status}. Exhausted codes are never touched${basics.status === "active" ? "; the offer is live, so the shop config is republished" : ""}.`,
          data: { promoRef: ref, offerId, status: args.status, codesToChange: changing.length, offerStatus: basics.status },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        if (a.expectedUpdatedAt && basics.updatedAt.getTime() !== a.expectedUpdatedAt.getTime()) {
          throw new ToolError("STATE_CONFLICT", "The offer changed since the dry run; run it again.");
        }
        // Snapshot and update in one transaction so the restore below puts back exactly what this call changed.
        const { before, changed } = await ctx.db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const snapshot = await affected(txDb);
          return { before: snapshot, changed: await setDiscountCodesStatus(txDb, shop.id, offerId, target, args.status) };
        });
        const failure = await republishIfActive(ctx.db, shop.id, shop.myshopifyDomain, offerId, basics.status === "active", a.publish);
        if (failure) {
          const previous = new Map<string, string[]>();
          for (const row of before) previous.set(row.status, [...(previous.get(row.status) ?? []), row.id]);
          for (const [status, ids] of previous) {
            if (status === "active" || status === "disabled") await setDiscountCodesStatus(ctx.db, shop.id, offerId, { ids }, status);
          }
          // The failed publish may have reached Shopify partially; push the restored statuses through the normal path too.
          const resync = basics.status === "active" ? await (a.publish ?? tryPublishShop)(shop.id, shop.myshopifyDomain) : null;
          const synced = basics.status !== "active" || !resync;
          throw new ToolError("PUBLISH_FAILED", `Publishing to Shopify failed and the code statuses were restored (${failure.replace(/\s+/g, " ").slice(0, 300)}). ${synced ? "The restored statuses were re-synced to Shopify." : "Re-syncing the restored statuses also failed; the next successful publish will sync them."} The offer may have been paused so the shop stays consistent.`, {
            suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Check the offer's current status and publish errors, then retry." },
          });
        }
        await insertAuditLog(ctx.db, {
          shopId: shop.id,
          entityType: "offer",
          entityId: offerId,
          action: "codes_set_status",
          after: { status: args.status, codes: changed, scope: args.ids ? "ids" : args.batchId ? "batch" : "all", ...a.auditExtra },
          performedBy: a.performedBy,
        });
        return {
          summary: `Set ${changed} code(s) of ${ref} to ${args.status}.`,
          data: { promoRef: ref, offerId, status: args.status, codesChanged: changed },
          nextActions: [{ mcp: "promo-engine", tool: "codes_list", args: { ref }, why: "Verify the codes.", risk: "read" }],
        };
      },
    };
  });
}
