import { createHash } from "node:crypto";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, inArray } from "drizzle-orm";
import { discountCodeBatches, discountCodes, offers, type Db } from "@promo/db";
import { insertAuditLog } from "../../audit-log.server.js";
import { repairShopDrift, type DriftRepairContext } from "../../discount-reconciliation.server.js";
import { normalizePrefix, validateBatchSpec, type BatchSpec } from "../../discount-code-generation.js";
import { createDiscountCodeBatch, deleteDiscountCodes, setDiscountCodesStatus, validateBatchEntropy } from "../../discount-codes.server.js";
import { canToggleLimits, isLimitsEnforced, setLimitsEnforced } from "../../limits-enforced.server.js";
import { invalidateOfferDefinitions } from "../../offer-definitions.server.js";
import { activateDraftOffer, bulkPauseOffers } from "../../offer-lifecycle.server.js";
import { republishIfActive, tryPublishShop } from "../../offer-publish-flow.server.js";
import { listLimitedTitleCollisions } from "../../offer-usage.server.js";
import { publishOffersForShop } from "../../sync/offer-publisher.server.js";
import { ToolError, promoRef, publishAdvisories, shopHandle, type Warning } from "../result.server.js";
import { selectShops } from "../shops.server.js";
import { lifecycleToolError, type ApplyContext, type CallInfo } from "../write-runner.server.js";
import type { McpContext } from "../server.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";
import { expectOk, guarded, iso, label, offerBasics, writeControls, type Controls } from "./write-tools.server.js";

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

export const MAX_CODES_PER_BATCH_CALL = 500;
export const MAX_CODES_PER_DELETE_CALL = 2000;
const LIST_CAP = 50;

export const promosPauseAllInput = {
  shop: z.string().max(200).describe("Shop domain or handle."),
  reason: z.string().trim().min(3).max(300).describe("Why (stored in the audit log)."),
  ...writeControls,
};
export const promoActivateDraftInput = { ...refFields, ...writeControls };
export const codesCreateBatchInput = {
  ...refFields,
  count: z.number().int().min(1).max(MAX_CODES_PER_BATCH_CALL).describe(`How many codes, 1-${MAX_CODES_PER_BATCH_CALL}.`),
  prefix: z.string().trim().max(32).optional().describe("Optional prefix (letters, digits, - and _ are kept)."),
  length: z.number().int().min(4).max(32).optional().describe("Random part length, 4-32 (default 8)."),
  ...writeControls,
};
export const codesDeleteInput = {
  ...refFields,
  ids: z.array(z.string().uuid()).min(1).max(MAX_CODES_PER_DELETE_CALL).optional().describe("Specific code ids (from codes_list)."),
  batchId: z.string().uuid().optional(),
  onlyUnused: z.boolean().optional().describe("Default true: codes that were ever redeemed are never deleted. false also deletes redeemed codes."),
  ...writeControls,
};
export const shopSetLimitsEnforcedInput = {
  shop: z.string().max(200).describe("Shop domain or handle."),
  enforced: z.boolean().describe("true turns per-cart / per-customer limits on for the shop's Functions."),
  ...writeControls,
};

export const driftRepairSettingsInput = {
  shop: z.string().max(200).describe("Shop domain or handle."),
  ...writeControls,
};

const withReason = (a: ApplyContext, why?: string) => (why ? { _mcp: { ...(a.auditExtra["_mcp"] as object), reason: why } } : a.auditExtra);

export function promosPauseAllTool(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; reason: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "promos_pause_all", "admin", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const live = async () =>
      ctx.db
        .select({ id: offers.id, name: offers.internalName, status: offers.status, updatedAt: offers.updatedAt })
        .from(offers)
        .where(and(eq(offers.shopId, shop!.id), inArray(offers.status, ["active", "scheduled"])));
    const newest = (rows: { updatedAt: Date }[]) => (rows.length ? new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))) : null);
    const describeRows = (rows: Awaited<ReturnType<typeof live>>) => ({
      shopDomain: shop!.myshopifyDomain,
      count: rows.length,
      offers: rows.slice(0, LIST_CAP).map((r) => ({ promoRef: promoRef(shop!.myshopifyDomain, r.id), name: label(r.name), statusBefore: r.status })),
      truncated: rows.length > LIST_CAP,
    });
    return {
      tool: "promos_pause_all",
      minRole: "admin",
      critical: true,
      shops: [shop!],
      preview: async () => {
        const rows = await live();
        const warnings: Warning[] =
          rows.length === 0 ? [{ code: "NOTHING_TO_PAUSE", severity: "info", message: "The shop has no active or scheduled offers." }] : [];
        return {
          summary: `Pause ${rows.length} active/scheduled offer(s) of ${shop!.myshopifyDomain} in one publish; rolled back if the publish fails. Resume them one by one with promo_resume.`,
          data: describeRows(rows),
          warnings,
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: newest(rows),
        };
      },
      apply: async (a) => {
        const rows = await live();
        const seen = newest(rows);
        if ((a.expectedUpdatedAt?.getTime() ?? null) !== (seen?.getTime() ?? null)) {
          throw new ToolError("STATE_CONFLICT", "The shop's live offers changed since the dry run; run it again.");
        }
        if (rows.length === 0) return { summary: `Nothing to pause in ${shop!.myshopifyDomain}.`, data: describeRows(rows) };
        const result = await bulkPauseOffers(
          ctx.db,
          { shopId: shop!.id, shopDomain: shop!.myshopifyDomain, offerIds: rows.map((r) => r.id) },
          { performedBy: a.performedBy, auditExtra: withReason(a, args.reason), publish: a.publish },
        );
        if (!result.ok) {
          if (result.code !== "publish_failed") throw lifecycleToolError(result);
          // Every offer went back to the status it had; say which, per status.
          const restored = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
          const summary = Object.entries(restored).map(([status, n]) => `${n} ${status}`).join(", ");
          throw new ToolError(
            "PUBLISH_FAILED",
            `Publishing to Shopify failed and the change was rolled back; ${summary} offer(s) kept their status (${result.error.replace(/\s+/g, " ").slice(0, 300)}).`,
            {
              suggestedAction: { mcp: "promo-engine", tool: "promo_health", args: { shops: [shop!.myshopifyDomain] }, why: "Check publish errors, then retry." },
              ...(result.capacity ? { details: { capacity: result.capacity } } : {}),
            },
          );
        }
        return {
          summary: `Paused ${result.offers.length} offer(s) of ${shop!.myshopifyDomain}. Shopify config republished.`,
          data: describeRows(rows),
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promos_active", args: { shops: [shop!.myshopifyDomain] }, why: "Verify nothing is live.", risk: "read" }],
        };
      },
    };
  });
}

export function promoActivateDraftTool(ctx: McpContext, call: CallInfo, args: Controls & { ref?: string; shop?: string }): Promise<CallToolResult> {
  return guarded(ctx, call, "promo_activate_draft", "admin", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const lifecycle = { shopId: shop.id, shopDomain: shop.myshopifyDomain, offerId };
    return {
      tool: "promo_activate_draft",
      minRole: "admin",
      critical: true,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const result = expectOk(await activateDraftOffer(ctx.db, lifecycle, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        return {
          summary: `Publish draft "${label(basics.name)}" (${ref}): ${result.statusBefore} -> ${result.statusAfter} (follows its schedule). The shop's Shopify config is republished and the status put back if that fails.`,
          data: { promoRef: ref, offerId, name: basics.name, statusBefore: result.statusBefore, statusAfter: result.statusAfter, willPublish: true },
          warnings: publishAdvisories(result.warnings),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: result.updatedAt,
        };
      },
      apply: async (a) => {
        const result = expectOk(
          await activateDraftOffer(ctx.db, lifecycle, {
            performedBy: a.performedBy,
            auditExtra: a.auditExtra,
            publish: a.publish,
            expectedUpdatedAt: a.expectedUpdatedAt ?? undefined,
          }),
          ref,
        );
        return {
          summary: `Published ${ref}: ${result.statusBefore} -> ${result.statusAfter}. Shopify config republished.`,
          data: { promoRef: ref, offerId, statusBefore: result.statusBefore, statusAfter: result.statusAfter },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new state.", risk: "read" }],
        };
      },
    };
  });
}

/** Keeps the prefix, hides the random part: enough to recognise a batch, never a usable code. */
export function maskCode(code: string, prefix: string): string {
  const keep = prefix && code.startsWith(prefix) ? prefix.length : 0;
  return code.slice(0, keep) + "*".repeat(code.length - keep);
}

export function codesCreateBatchTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; count: number; prefix?: string; length?: number },
): Promise<CallToolResult> {
  return guarded(ctx, call, "codes_create_batch", "admin", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const spec: BatchSpec = { prefix: args.prefix ?? "", length: args.length ?? 8, charset: "unambiguous", count: args.count };
    const specError = validateBatchSpec(spec) ?? validateBatchEntropy(spec);
    if (specError) throw new ToolError("VALIDATION", specError);
    const normalizedPrefix = normalizePrefix(spec.prefix);
    const assertUsable = (status: string) => {
      if (status === "archived") throw new ToolError("INVALID_STATE", "Archived offers can't get codes.");
    };

    return {
      tool: "codes_create_batch",
      minRole: "admin",
      critical: true,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        assertUsable(basics.status);
        return {
          summary: `Generate ${spec.count} app-generated code(s) (length ${spec.length}${normalizedPrefix ? `, prefix ${normalizedPrefix}` : ""}) for "${label(basics.name)}" (${ref}, ${basics.status})${basics.status === "active" ? "; it is live, so the shop config is republished" : ""}. The codes are never returned here: export them from the offer's Codes tab in the admin.`,
          data: { promoRef: ref, offerId, count: spec.count, length: spec.length, prefix: normalizedPrefix, offerStatus: basics.status },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const [basics] = await ctx.db
          .select({ status: offers.status, updatedAt: offers.updatedAt, requiresCode: offers.requiresCode })
          .from(offers)
          .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)))
          .limit(1);
        if (!basics) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
        assertUsable(basics.status);
        if (a.expectedUpdatedAt && basics.updatedAt.getTime() !== a.expectedUpdatedAt.getTime()) {
          throw new ToolError("STATE_CONFLICT", "The offer changed since the dry run; run it again.");
        }
        const created = await createDiscountCodeBatch(ctx.db, { shopId: shop.id, offerId, spec });
        if (!created.ok) throw new ToolError("VALIDATION", created.error.replace(/\s+/g, " ").slice(0, 300));
        const failure = await republishIfActive(ctx.db, shop.id, shop.myshopifyDomain, offerId, basics.status === "active", a.publish);
        if (failure) {
          await undoBatch(ctx.db, shop.id, offerId, created.batchId, basics.requiresCode);
          const resync = basics.status === "active" ? await (a.publish ?? tryPublishShop)(shop.id, shop.myshopifyDomain) : null;
          throw new ToolError(
            "PUBLISH_FAILED",
            `Publishing to Shopify failed and the new batch was removed (${failure.replace(/\s+/g, " ").slice(0, 300)}). ${resync ? "Re-syncing the previous state also failed; the next successful publish will sync it." : "The previous state was re-synced to Shopify."} The offer may have been paused so the shop stays consistent.`,
            { suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Check the offer's current status and publish errors, then retry." } },
          );
        }
        const samples = await ctx.db
          .select({ code: discountCodes.code })
          .from(discountCodes)
          .where(and(eq(discountCodes.shopId, shop.id), eq(discountCodes.batchId, created.batchId)))
          .limit(3);
        await insertAuditLog(ctx.db, {
          shopId: shop.id,
          entityType: "offer",
          entityId: offerId,
          action: "codes_create_batch",
          after: { batchId: created.batchId, count: created.created, length: spec.length, ...a.auditExtra },
          performedBy: a.performedBy,
        });
        return {
          summary: `Generated ${created.created} code(s) for ${ref} (batch ${created.batchId}). Plaintext codes are not returned over MCP: export the batch from the offer's Codes tab in the admin.`,
          data: { promoRef: ref, offerId, batchId: created.batchId, created: created.created, maskedSamples: samples.map((s) => maskCode(s.code, normalizedPrefix)) },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "codes_list", args: { ref }, why: "Verify the batch (codes are masked).", risk: "read" }],
        };
      },
    };
  });
}

async function undoBatch(db: Db, shopId: string, offerId: string, batchId: string, requiredCodeBefore: boolean) {
  const rows = await db
    .select({ id: discountCodes.id })
    .from(discountCodes)
    .where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.batchId, batchId)));
  const ids = rows.map((r) => r.id);
  await deleteDiscountCodes(db, shopId, offerId, ids);
  // A code that already reached Shopify can't be deleted here; disabling it keeps it from being redeemed.
  await setDiscountCodesStatus(db, shopId, offerId, { batchId }, "disabled");
  const [left] = await db.select({ id: discountCodes.id }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.batchId, batchId))).limit(1);
  if (!left) await db.delete(discountCodeBatches).where(and(eq(discountCodeBatches.shopId, shopId), eq(discountCodeBatches.id, batchId)));
  if (!requiredCodeBefore) {
    const [other] = await db.select({ id: discountCodes.id }).from(discountCodes).where(and(eq(discountCodes.shopId, shopId), eq(discountCodes.offerId, offerId))).limit(1);
    if (!other) await db.update(offers).set({ requiresCode: false }).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)));
  }
}

export function codesDeleteTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { ref?: string; shop?: string; ids?: string[]; batchId?: string; onlyUnused?: boolean },
): Promise<CallToolResult> {
  return guarded(ctx, call, "codes_delete", "admin", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    if ((args.ids ? 1 : 0) + (args.batchId ? 1 : 0) !== 1) throw new ToolError("VALIDATION", "Pass exactly one of ids or batchId.");
    const onlyUnused = args.onlyUnused !== false;

    const classify = async () => {
      const filters = [eq(discountCodes.shopId, shop.id), eq(discountCodes.offerId, offerId)];
      if (args.ids) filters.push(inArray(discountCodes.id, args.ids));
      else filters.push(eq(discountCodes.batchId, args.batchId!));
      const rows = await ctx.db
        .select({
          id: discountCodes.id,
          usageCount: discountCodes.usageCount,
          syncedAt: discountCodes.shopifySyncedAt,
          pendingAt: discountCodes.shopifySyncPendingAt,
        })
        .from(discountCodes)
        .where(and(...filters))
        .limit(MAX_CODES_PER_DELETE_CALL + 1);
      if (rows.length > MAX_CODES_PER_DELETE_CALL) {
        throw new ToolError("VALIDATION", `More than ${MAX_CODES_PER_DELETE_CALL} codes match; delete the batch in several calls with ids.`);
      }
      const onShopify = rows.filter((r) => r.syncedAt || r.pendingAt);
      const removable = rows.filter((r) => !r.syncedAt && !r.pendingAt);
      const skippedUsed = onlyUnused ? removable.filter((r) => r.usageCount > 0) : [];
      const deletable = onlyUnused ? removable.filter((r) => r.usageCount === 0) : removable;
      const ids = deletable.map((r) => r.id).sort();
      return {
        deletable: ids,
        setHash: createHash("sha256").update(ids.join(",")).digest("hex"),
        counts: {
          matched: rows.length,
          deletable: deletable.length,
          skippedUsed: skippedUsed.length,
          skippedOnShopify: onShopify.length,
          redeemedAmongDeletable: deletable.filter((r) => r.usageCount > 0).length,
        },
      };
    };

    return {
      tool: "codes_delete",
      minRole: "admin",
      critical: true,
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const { counts, setHash } = await classify();
        if (counts.matched === 0) throw new ToolError("NOT_FOUND", "No codes match in that offer.");
        if (counts.deletable === 0) {
          throw new ToolError(
            "VALIDATION",
            `Nothing can be deleted: ${counts.skippedUsed} redeemed code(s) are protected by onlyUnused, ${counts.skippedOnShopify} still exist on Shopify (disable them with codes_set_status and let the publish remove them first).`,
          );
        }
        const warnings: Warning[] = [];
        if (counts.redeemedAmongDeletable > 0) {
          warnings.push({ code: "DELETES_REDEEMED_CODES", severity: "warn", message: `${counts.redeemedAmongDeletable} code(s) that were redeemed will be deleted (onlyUnused=false).` });
        }
        if (counts.skippedOnShopify > 0) {
          warnings.push({ code: "STILL_ON_SHOPIFY", severity: "info", message: `${counts.skippedOnShopify} code(s) are still on Shopify and will be kept.` });
        }
        return {
          summary: `Delete ${counts.deletable} of ${counts.matched} matching code(s) of "${label(basics.name)}" (${ref}); onlyUnused=${onlyUnused}. Irreversible.`,
          data: { promoRef: ref, offerId, onlyUnused, ...counts },
          warnings,
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
          setHash,
        };
      },
      apply: async (a) => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        if (a.expectedUpdatedAt && basics.updatedAt.getTime() !== a.expectedUpdatedAt.getTime()) {
          throw new ToolError("STATE_CONFLICT", "The offer changed since the dry run; run it again.");
        }
        const { deletable, counts, setHash } = await classify();
        if (deletable.length === 0) throw new ToolError("STATE_CONFLICT", "Nothing deletable any more; run the dry run again.");
        // The token pins the exact codes the dry run showed: a redemption, sync or new code since then changes the set.
        if (a.expectedSetHash !== setHash) throw new ToolError("STATE_CONFLICT", "The codes to delete changed since the dry run; run it again.");
        const deleted = await deleteDiscountCodes(ctx.db, shop.id, offerId, deletable, { onlyUnused });
        await insertAuditLog(ctx.db, {
          shopId: shop.id,
          entityType: "offer",
          entityId: offerId,
          action: "codes_delete",
          after: { deleted, onlyUnused, scope: args.ids ? "ids" : "batch", batchId: args.batchId ?? null, ...a.auditExtra },
          performedBy: a.performedBy,
        });
        return {
          summary: `Deleted ${deleted} code(s) of ${ref}${deleted < counts.deletable ? ` (${counts.deletable - deleted} could not be deleted: they were sent to Shopify meanwhile)` : ""}.`,
          data: { promoRef: ref, offerId, deleted, ...counts },
          nextActions: [{ mcp: "promo-engine", tool: "codes_list", args: { ref }, why: "Verify the codes.", risk: "read" }],
        };
      },
    };
  });
}

export function shopSetLimitsEnforcedTool(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; enforced: boolean }): Promise<CallToolResult> {
  return guarded(ctx, call, "shop_set_limits_enforced", "admin", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const domain = shop!.myshopifyDomain;
    // The same gates as Settings -> Limits: the LIMITS_TOGGLE_SHOPS allow-list and, to turn it on, no shared-title collisions.
    const assertPreconditions = async () => {
      if (!canToggleLimits(domain, ctx.env)) {
        throw new ToolError("VALIDATION", `${domain} is not in LIMITS_TOGGLE_SHOPS. Add it in the shop's Vercel project and redeploy first (docs/RUNBOOK.md, limits rollout); the MCP never changes env.`);
      }
      if (args.enforced) {
        const collisions = await listLimitedTitleCollisions(ctx.db, shop!.id);
        if (collisions.length > 0) {
          const list = collisions.map((c) => `"${c.title}": ${c.offers.join(", ")}`).join("; ").slice(0, 250);
          throw new ToolError("VALIDATION", `Limits can't be enforced yet: limited automatic offers share a discount title (${list}). Give each a unique public title (pnpm limits:review).`);
        }
      }
    };
    return {
      tool: "shop_set_limits_enforced",
      minRole: "admin",
      critical: true,
      shops: [shop!],
      preview: async () => {
        await assertPreconditions();
        const current = await isLimitsEnforced(ctx.db, shop!.id);
        const warnings: Warning[] = args.enforced
          ? [{ code: "BACKFILL_NOT_VERIFIED", severity: "warn", message: "The usage backfill (pnpm limits:review, backfill dry-run then --apply) can't be verified from here; make sure it ran before enabling." }]
          : [];
        return {
          summary: `Set limits.enforced on ${domain}: ${current} -> ${args.enforced}. The shop's offers are republished so the Functions pick it up; the flag is reverted if that fails.`,
          data: { shopDomain: domain, enforcedBefore: current, enforcedAfter: args.enforced, changed: current !== args.enforced },
          warnings,
          links: [adminLink(shopHandle(domain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        await assertPreconditions();
        const previous = await isLimitsEnforced(ctx.db, shop!.id);
        if (previous === args.enforced) {
          return { summary: `limits.enforced is already ${args.enforced} on ${domain}; nothing changed.`, data: { shopDomain: domain, enforced: previous, changed: false } };
        }
        await setLimitsEnforced(ctx.db, shop!.id, args.enforced, a.performedBy, a.auditExtra);
        await invalidateOfferDefinitions(shop!.id);
        const failure = await (a.publish ?? tryPublishShop)(shop!.id, domain);
        if (failure) {
          await setLimitsEnforced(ctx.db, shop!.id, previous, a.performedBy, a.auditExtra);
          await invalidateOfferDefinitions(shop!.id);
          throw new ToolError("PUBLISH_FAILED", `Republishing to Shopify failed and limits.enforced was reverted to ${previous} (${failure.message.replace(/\s+/g, " ").slice(0, 300)}).`, {
            suggestedAction: { mcp: "promo-engine", tool: "promo_health", args: { shops: [domain] }, why: "Check publish errors, then retry." },
          });
        }
        return {
          summary: `limits.enforced on ${domain}: ${previous} -> ${args.enforced}. Shopify config republished.`,
          data: { shopDomain: domain, enforced: args.enforced, changed: true, at: iso(new Date()) },
          nextActions: [{ mcp: "promo-engine", tool: "promo_health", args: { shops: [domain] }, why: "Confirm there are no publish errors.", risk: "read" }],
        };
      },
    };
  });
}

const ITEM_CAP = 50;

export function driftRepairSettingsTool(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string },
  deps: DriftRepairContext = {},
): Promise<CallToolResult> {
  return guarded(ctx, call, "drift_repair_settings", "admin", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const domain = shop!.myshopifyDomain;
    const driftDeps: DriftRepairContext = {
      ...deps,
      publish:
        deps.publish ??
        (ctx.publish
          ? async (shopId, shopDomain) => {
              const failure = await ctx.publish!(shopId, shopDomain);
              if (failure) throw new Error(failure.message);
              return null;
            }
          : async (shopId, shopDomain) => {
              const outcome = await publishOffersForShop(shopId, shopDomain);
              await invalidateOfferDefinitions(shopId);
              return outcome;
            }),
    };
    const describe = (r: Awaited<ReturnType<typeof repairShopDrift>>) => ({
      shopDomain: domain,
      outcome: r.outcome,
      itemCount: r.items.length,
      items: r.items.slice(0, ITEM_CAP),
      truncated: r.items.length > ITEM_CAP,
      wouldWrite: r.wouldWrite,
      diffHash: r.diffHash,
    });
    const blocked = (outcome: string) => {
      if (outcome === "no_nodes") return new ToolError("INVALID_STATE", `${domain} has never published discount nodes; there is nothing to drift from.`);
      if (outcome === "settling") return new ToolError("INVALID_STATE", `${domain} was published less than 2 minutes ago and may still be writing; retry shortly.`);
      return null;
    };
    return {
      tool: "drift_repair_settings",
      minRole: "admin",
      critical: true,
      shops: [shop!],
      preview: async () => {
        const result = await repairShopDrift(ctx.db, driftDeps, { shopId: shop!.id, dryRun: true });
        const error = blocked(result.outcome);
        if (error) throw error;
        const warnings: Warning[] = [];
        if (result.outcome === "clean") warnings.push({ code: "NO_DRIFT", severity: "info", message: "Everything the last publish wrote is still on Shopify; executing changes nothing." });
        if (result.outcome === "paused") {
          warnings.push({ code: "REPAIR_PAUSED", severity: "warn", message: "Drift repair is paused for this shop (drift_repair.paused or DRIFT_REPAIR_DISABLED); executing is refused until it is resumed." });
        }
        return {
          summary: result.items.length
            ? `${result.items.length} item(s) out of sync on ${domain}. Executing republishes the shop config to Shopify (${result.wouldWrite.length} write step(s), listed in wouldWrite).`
            : `No drift on ${domain}.`,
          data: describe(result),
          warnings,
          links: [adminLink(shopHandle(domain))],
          offerUpdatedAt: null,
          setHash: result.diffHash,
        };
      },
      apply: async (a) => {
        const result = await repairShopDrift(ctx.db, driftDeps, {
          shopId: shop!.id,
          dryRun: false,
          performedBy: a.performedBy,
          auditExtra: a.auditExtra,
          expectedDiffHash: a.expectedSetHash,
        });
        const error = blocked(result.outcome);
        if (error) throw error;
        if (result.outcome === "diff_changed") throw new ToolError("STATE_CONFLICT", "What is out of sync changed since the dry run; run it again.");
        if (result.outcome === "paused") throw new ToolError("INVALID_STATE", "Drift repair is paused for this shop (drift_repair.paused or DRIFT_REPAIR_DISABLED).");
        const warnings: Warning[] =
          result.outcome === "unresolved"
            ? [{ code: "DRIFT_UNRESOLVED", severity: "warn", message: `${result.unresolved.length} item(s) are still out of sync after the republish; a Sentry alert was raised.` }]
            : result.outcome === "deferred"
              ? [{ code: "REPAIR_DEFERRED", severity: "info", message: "The publish was parked behind another publish; the cron retries it." }]
              : [];
        const summary = {
          clean: `No drift on ${domain}; nothing changed.`,
          repaired: `Repaired ${result.items.length} item(s) on ${domain}; Shopify config republished and verified.`,
          deferred: `Repair queued on ${domain}: the publish was parked and will be retried.`,
          unresolved: `Republished ${domain}, but ${result.unresolved.length} item(s) are still out of sync.`,
        }[result.outcome as "clean" | "repaired" | "deferred" | "unresolved"];
        return {
          summary,
          data: { ...describe(result), unresolved: result.unresolved.map(({ issue, nodeId, detail }) => ({ issue, nodeId, detail })) },
          warnings,
          links: [adminLink(shopHandle(domain))],
          nextActions: [{ mcp: "promo-engine", tool: "discount_capacity", args: { shops: [domain], live: true }, why: "Check the live nodes after the repair.", risk: "read" }],
        };
      },
    };
  });
}
