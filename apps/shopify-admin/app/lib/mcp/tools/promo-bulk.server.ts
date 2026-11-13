import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import {
  BULK_ACTIONS,
  MAX_BULK_ITEMS,
  SETTABLE_STATUSES,
  bulkOffers,
  deleteOffer,
  setOfferStatus,
  type BulkAction,
  type BulkItemResult,
  type SettableStatus,
} from "../../offer-bulk.server.js";
import type { OfferLifecycleFailure, OfferLifecycleResult, OfferLifecycleSuccess } from "../../offer-lifecycle.server.js";
import { getRestorableOffers, restoreArchivedOffers } from "../../restore-archived-offers.server.js";
import { tryPublishShop } from "../../offer-publish-flow.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, capacityToolError, promoRef, publishAdvisories, shopHandle, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { lifecycleToolError, runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, likePattern, resolvePromoRef } from "./catalog-shared.server.js";

const controls = {
  dryRun: z.boolean().optional().describe("Default false. true previews the outcome (validation, capacity, per-item results) and writes nothing."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

export const promoSetStatusInput = {
  ...refFields,
  status: z.enum(SETTABLE_STATUSES).describe("Target status. draft->active validates conditions, reward, activation and the Shopify capacity preflight (the schedule decides active/scheduled/expired); paused->active resumes; active|scheduled->paused pauses; any->archived archives; active|scheduled|paused->draft unpublishes. Other moves answer INVALID_STATE."),
  ...controls,
};
export const promoDeleteInput = { ...refFields, ...controls };

const filterShape = z
  .strictObject({
    status: z.array(z.enum(["draft", "active", "scheduled", "paused", "expired", "archived"])).max(6).optional().describe("Offer statuses."),
    type: z.array(z.enum(["gift", "bundle", "upsell", "discount", "booster"])).max(5).optional().describe("Offer types."),
    query: z.string().trim().max(120).optional().describe("Substring of the internal name or public title."),
  })
  .describe("Selects offers of ONE shop (needs `shop`). More than 200 matches is an error: narrow the filter.");

export const promosBulkInput = {
  action: z.enum(BULK_ACTIONS).describe("pause (live offers), activate (draft or paused), archive, duplicate (as a draft copy) or delete (hard delete, irreversible)."),
  refs: z.array(z.string().max(200)).min(1).max(MAX_BULK_ITEMS).optional().describe("promo:<shopHandle>:<offerId> refs (may span shops), or bare offerIds together with `shop`. Max 200."),
  shop: z.string().max(200).optional().describe("Shop for bare offerIds and for `filter`."),
  filter: filterShape.optional(),
  ...controls,
};
export const promosRestoreArchivedInput = {
  shop: z.string().max(200).describe("Shop domain or handle."),
  ...controls,
};

type Controls = { dryRun?: boolean; idempotencyKey?: string };
type Built = { tool: string; shops: VisibleShop[]; preview: () => Promise<WritePreview>; apply: (apply: ApplyContext) => Promise<WriteBody> };

/** Resolves refs/shops (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function guarded(
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

/** CAPACITY_LIMIT for a Shopify capacity block, else the lifecycle mapping. */
export function bulkToolError(failure: OfferLifecycleFailure, ref?: string): ToolError {
  const capacity = "capacity" in failure ? failure.capacity : undefined;
  if (capacity && (failure.code === "validation" || failure.code === "publish_failed")) {
    return capacityToolError(capacity, failure.error.replace(/\s+/g, " ").slice(0, 300));
  }
  return lifecycleToolError(failure, ref);
}

function expectOk(result: OfferLifecycleResult, ref: string): OfferLifecycleSuccess {
  if (!result.ok) throw bulkToolError(result, ref);
  return result;
}

const label = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 80);

async function offerBasics(db: Db, shop: VisibleShop, offerId: string) {
  const [row] = await db
    .select({ name: offers.internalName, status: offers.status, updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)))
    .limit(1);
  if (!row) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  return row;
}

export function promoSetStatusTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string; status: SettableStatus }): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_set_status", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const lifecycle = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId };
    return {
      tool: "promo_set_status",
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const r = expectOk(await setOfferStatus(ctx.db, lifecycle, args.status, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        return {
          summary: `Set "${label(basics.name)}" (${ref}) to ${args.status}: ${r.statusBefore} -> ${r.statusAfter}. The shop's Shopify config is republished and rolled back if that fails.`,
          data: { promoRef: ref, offerId, name: basics.name, statusBefore: r.statusBefore, statusAfter: r.statusAfter, willPublish: true },
          warnings: publishAdvisories(r.warnings),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: r.updatedAt,
        };
      },
      apply: async (a) => {
        const r = expectOk(
          await setOfferStatus(ctx.db, lifecycle, args.status, {
            performedBy: a.performedBy,
            auditExtra: a.auditExtra,
            publish: a.publish,
            expectedUpdatedAt: a.expectedUpdatedAt ?? undefined,
          }),
          ref,
        );
        return {
          summary: `Set ${ref} to ${args.status}: ${r.statusBefore} -> ${r.statusAfter}. Shopify config republished.`,
          data: { promoRef: ref, offerId, statusBefore: r.statusBefore, statusAfter: r.statusAfter },
          warnings: publishAdvisories(r.warnings),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new state.", risk: "read" }],
        };
      },
    };
  });
}

export function promoDeleteTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_delete", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const lifecycle = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId };
    const unwrap = (r: Awaited<ReturnType<typeof deleteOffer>>) => {
      if (r.ok) return r;
      throw bulkToolError(r as OfferLifecycleFailure, ref);
    };
    return {
      tool: "promo_delete",
      shops: [shop],
      preview: async () => {
        const r = unwrap(await deleteOffer(ctx.db, lifecycle, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }));
        return {
          summary: `Permanently delete "${label(r.name)}" (${ref}, ${r.statusBefore}) with its analytics, widgets and bundle definition.${r.wasLive ? " It is live: the shop's Shopify config is republished without it." : ""} Irreversible; use promo_set_status archived to keep it.`,
          data: { promoRef: ref, offerId, name: r.name, statusBefore: r.statusBefore, willPublish: true, reversible: false },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const r = unwrap(await deleteOffer(ctx.db, lifecycle, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }));
        return {
          summary: `Deleted ${ref} ("${label(r.name)}"). Shopify config republished.`,
          data: { promoRef: ref, offerId, name: r.name, statusBefore: r.statusBefore },
          warnings: r.neutralizeError
            ? [{ code: "NEUTRALIZE_FAILED", severity: "warn", message: "The dedicated checkout-code discount in Shopify could not be neutralized; check it in the Shopify admin." } satisfies Warning]
            : undefined,
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
        };
      },
    };
  });
}

type BulkArgs = Controls & { action: BulkAction; refs?: string[]; shop?: string; filter?: { status?: string[]; type?: string[]; query?: string } };

async function matchFilter(db: Db, shop: VisibleShop, filter: NonNullable<BulkArgs["filter"]>): Promise<string[]> {
  const where = [eq(offers.shopId, shop.id)];
  if (filter.status?.length) where.push(inArray(offers.status, filter.status as never));
  if (filter.type?.length) where.push(inArray(offers.type, filter.type as never));
  if (filter.query?.trim()) {
    const pattern = likePattern(filter.query);
    where.push(or(ilike(offers.internalName, pattern), ilike(offers.publicTitle, pattern))!);
  }
  const rows = await db.select({ id: offers.id }).from(offers).where(and(...where)).limit(MAX_BULK_ITEMS + 1);
  if (rows.length > MAX_BULK_ITEMS) throw new ToolError("VALIDATION", `The filter matches more than ${MAX_BULK_ITEMS} offers; narrow it (status, type, query) or send explicit refs in batches.`);
  return rows.map((r) => r.id);
}

/** shop -> offer ids, from refs (any shop) or from filter + shop. */
async function selection(ctx: McpContext, visible: VisibleShop[], args: BulkArgs): Promise<Map<VisibleShop, string[]>> {
  if (Boolean(args.refs?.length) === Boolean(args.filter)) throw new ToolError("VALIDATION", "Pass exactly one of refs or filter.");
  const out = new Map<VisibleShop, string[]>();
  if (args.refs) {
    for (const r of args.refs) {
      const { shop, offerId } = resolvePromoRef(visible, { ref: r, shop: args.shop });
      const key = [...out.keys()].find((s) => s.id === shop.id) ?? shop;
      out.set(key, [...new Set([...(out.get(key) ?? []), offerId])]);
    }
  } else {
    if (!args.shop) throw new ToolError("VALIDATION", "filter needs `shop`.");
    const [shop] = selectShops(visible, [args.shop]);
    out.set(shop!, await matchFilter(ctx.db, shop!, args.filter!));
  }
  const total = [...out.values()].reduce((n, ids) => n + ids.length, 0);
  if (total === 0) throw new ToolError("NOT_FOUND", "No offer matches the selection.");
  if (total > MAX_BULK_ITEMS) throw new ToolError("VALIDATION", `At most ${MAX_BULK_ITEMS} offers per call.`);
  return out;
}

const itemLine = (shop: VisibleShop, i: BulkItemResult) => ({ promoRef: promoRef(shop.myshopifyDomain, i.offerId), ...i });

export function promosBulkTool(ctx: McpContext, call: CallInfo, args: BulkArgs): Promise<CallToolResult> {
  return guarded(ctx, call, "promos_bulk", args, async (visible) => {
    const picked = await selection(ctx, visible, args);
    const shopsList = [...picked.keys()];
    const run = async (dryRun: boolean, a?: ApplyContext) => {
      const perShop: Array<{ shop: VisibleShop; items: ReturnType<typeof itemLine>[]; succeeded: number; failed: number }> = [];
      for (const [shop, offerIds] of picked) {
        const r = await bulkOffers(
          ctx.db,
          { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerIds },
          args.action,
          { performedBy: a?.performedBy ?? `mcp:${ctx.operator.id}`, auditExtra: a?.auditExtra, publish: a?.publish, dryRun },
        );
        perShop.push({ shop, items: r.items.map((i) => itemLine(shop, i)), succeeded: r.succeeded, failed: r.failed });
      }
      const succeeded = perShop.reduce((n, s) => n + s.succeeded, 0);
      const failed = perShop.reduce((n, s) => n + s.failed, 0);
      const items = perShop.flatMap((s) => s.items);
      const warnings: Warning[] = failed
        ? [{ code: "PARTIAL_FAILURE", severity: "warn", message: `${failed} of ${succeeded + failed} offer(s) ${dryRun ? "would fail" : "failed"}: see data.items[].error. The others ${dryRun ? "would be" : "were"} processed.` }]
        : [];
      return { items, succeeded, failed, warnings, shops: perShop.map((s) => s.shop) };
    };
    return {
      tool: "promos_bulk",
      shops: shopsList,
      preview: async () => {
        const r = await run(true);
        return {
          summary: `${args.action} on ${r.succeeded + r.failed} offer(s): ${r.succeeded} would succeed, ${r.failed} would fail.${args.action === "delete" ? " Delete is irreversible." : ""}`,
          data: { action: args.action, succeeded: r.succeeded, failed: r.failed, items: r.items },
          warnings: r.warnings,
          links: r.shops.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const r = await run(false, a);
        return {
          summary: `${args.action}: ${r.succeeded} of ${r.succeeded + r.failed} offer(s) done${r.failed ? `, ${r.failed} failed` : ""}.`,
          data: { action: args.action, succeeded: r.succeeded, failed: r.failed, items: r.items },
          warnings: r.warnings,
          links: r.shops.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
        };
      },
    };
  });
}

export function promosRestoreArchivedTool(ctx: McpContext, call: CallInfo, args: Controls & { shop: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "promos_restore_archived", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    return {
      tool: "promos_restore_archived",
      shops: [shop!],
      preview: async () => {
        const { count } = await getRestorableOffers(ctx.db, shop!.id);
        return {
          summary: `${count} offer(s) archived by the uninstall of ${shop!.myshopifyDomain} can be restored (each is re-validated; the shop's Shopify config is republished).`,
          data: { restorable: count },
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const publish = a.publish ?? tryPublishShop;
        let result: { restored: number; failed: number };
        try {
          result = await restoreArchivedOffers(
            { db: ctx.db, shopId: shop!.id, shopDomain: shop!.myshopifyDomain },
            { publish: async (shopId, shopDomain) => (await publish(shopId, shopDomain))?.message ?? null },
          );
        } catch (error) {
          throw new ToolError("PUBLISH_FAILED", `Publishing to Shopify failed and nothing was restored (${(error instanceof Error ? error.message : "unknown error").replace(/\s+/g, " ").slice(0, 200)}).`);
        }
        return {
          summary: `Restored ${result.restored} offer(s)${result.failed ? `; ${result.failed} could not be restored (invalid now, or their code is held by another live offer) and stay archived` : ""}.`,
          data: { restored: result.restored, failed: result.failed },
          warnings: result.failed ? [{ code: "PARTIAL_FAILURE", severity: "warn", message: `${result.failed} offer(s) stayed archived.` }] : undefined,
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
        };
      },
    };
  });
}
