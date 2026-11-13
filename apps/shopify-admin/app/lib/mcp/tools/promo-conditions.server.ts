import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { offerConditions, offers } from "@promo/db";
import { addCondition, deleteCondition, setSubconditions, updateCondition, type ConditionFailure } from "../../offer-conditions.server.js";
import { AuthoringConditionSchema, defaultScopeFor, toConditionInput, toStoredConditions } from "../../offer-authoring/conditions.js";
import type { AuthoringDeps, WriteServiceOptions } from "../../offer-authoring/types.js";
import { ToolError, promoRef, shopHandle } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { visibleShops, type VisibleShop } from "../shops.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

const writeControls = {
  dryRun: z.boolean().optional().describe("Optional preview (default false): validates and shows the outcome, writes and publishes nothing."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};

export const promoConditionUpsertInput = {
  ...refFields,
  conditionId: z.string().uuid().optional().describe("Condition to update (from promo_detail). Omit to add a new condition."),
  condition: AuthoringConditionSchema.describe("The condition, discriminated by `type`. Money in major units."),
  ...writeControls,
};
export const promoConditionDeleteInput = {
  ...refFields,
  conditionId: z.string().uuid().describe("Condition to delete (from promo_detail)."),
  ...writeControls,
};
export const promoSubconditionsSetInput = {
  ...refFields,
  subconditions: z.array(AuthoringConditionSchema).max(20).describe("The COMPLETE list of sub-conditions (extra gates); replaces every existing sub-condition. [] removes them all."),
  ...writeControls,
};

type Args = Record<string, unknown> & { dryRun?: boolean; idempotencyKey?: string };

const safeText = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

function conditionToolError(failure: ConditionFailure): ToolError {
  switch (failure.code) {
    case "not_found":
    case "condition_not_found":
      return new ToolError("NOT_FOUND", failure.error);
    case "stale":
      return new ToolError("STATE_CONFLICT", failure.error);
    case "publish_failed":
      return new ToolError("PUBLISH_FAILED", `The change was saved but publishing failed: ${safeText(failure.error)}`);
    case "warnings":
    case "validation":
      return new ToolError("VALIDATION", safeText(failure.error));
  }
}

async function offerUpdatedAt(ctx: McpContext, shop: VisibleShop, offerId: string): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ updatedAt: offers.updatedAt })
    .from(offers)
    .where(and(eq(offers.shopId, shop.id), eq(offers.id, offerId)))
    .limit(1);
  if (!row) throw new ToolError("NOT_FOUND", "Offer not found in that shop.");
  return row.updatedAt;
}

type Built = {
  tool: string;
  shop: VisibleShop;
  offerId: string;
  /** Runs the service; `opts.dryRun` decides whether it writes. Returns the body without links. */
  run: (deps: AuthoringDeps, opts: WriteServiceOptions) => Promise<Omit<WriteBody, "links">>;
};

/** Resolves the offer ref (failures are logged and returned as tool errors), then hands the spec to runWrite. */
async function write(ctx: McpContext, call: CallInfo, tool: string, args: Args, build: (visible: VisibleShop[]) => Promise<Built>): Promise<CallToolResult> {
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
  const { shop, offerId } = built;
  const deps: AuthoringDeps = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode ?? "USD", timezone: shop.timezone ?? "UTC" };
  const links = [adminLink(shopHandle(shop.myshopifyDomain))];
  return runWrite(ctx, call, {
    tool,
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async (): Promise<WritePreview> => ({
      ...(await built.run(deps, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true })),
      links,
      offerUpdatedAt: await offerUpdatedAt(ctx, shop, offerId),
    }),
    apply: async (a: ApplyContext) => ({
      ...(await built.run(deps, {
        performedBy: a.performedBy,
        auditExtra: a.auditExtra,
        publish: a.publish,
        expectedUpdatedAt: a.expectedUpdatedAt ?? undefined,
      })),
      links,
    }),
  });
}

const detailAction = (ref: string) => [{ mcp: "promo-engine" as const, tool: "promo_detail", args: { ref }, why: "Check the offer's conditions.", risk: "read" as const }];

export function promoConditionUpsertTool(ctx: McpContext, call: CallInfo, args: Args & { conditionId?: string; condition: z.infer<typeof AuthoringConditionSchema>; ref?: string; shop?: string }): Promise<CallToolResult> {
  return write(ctx, call, "promo_condition_upsert", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    return {
      tool: "promo_condition_upsert",
      shop,
      offerId,
      run: async (deps, opts) => {
        const input = toConditionInput(args.condition);
        let result;
        if (args.conditionId) {
          // An update without an explicit scope keeps the stored one instead of resetting it to the type's default.
          const [existing] = await ctx.db
            .select({ scope: offerConditions.scope })
            .from(offerConditions)
            .where(and(eq(offerConditions.shopId, shop.id), eq(offerConditions.offerId, offerId), eq(offerConditions.id, args.conditionId)))
            .limit(1);
          result = await updateCondition(deps, { offerId, conditionId: args.conditionId, scope: args.condition.scope ?? existing?.scope ?? defaultScopeFor(args.condition.type), condition: input }, opts);
        } else {
          result = await addCondition(deps, { offerId, scope: args.condition.scope ?? defaultScopeFor(args.condition.type), condition: input }, opts);
        }
        if (!result.ok) throw conditionToolError(result);
        const verb = args.conditionId ? "Update" : "Add";
        return {
          summary: opts.dryRun
            ? `${verb} ${result.scope} condition ${result.conditionType} on ${ref}; stored as ${JSON.stringify(result.value).slice(0, 200)}.`
            : `${verb === "Add" ? "Added" : "Updated"} ${result.scope} condition ${result.conditionType} on ${ref}${result.published ? " and republished the shop" : ""}.`,
          data: { promoRef: ref, offerId, conditionId: result.conditionId, scope: result.scope, conditionType: result.conditionType, operator: result.operator, value: result.value },
          nextActions: detailAction(ref),
        };
      },
    };
  });
}

export function promoConditionDeleteTool(ctx: McpContext, call: CallInfo, args: Args & { conditionId: string; ref?: string; shop?: string }): Promise<CallToolResult> {
  return write(ctx, call, "promo_condition_delete", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    return {
      tool: "promo_condition_delete",
      shop,
      offerId,
      run: async (deps, opts) => {
        const result = await deleteCondition(deps, { offerId, conditionId: args.conditionId }, opts);
        if (!result.ok) throw conditionToolError(result);
        return {
          summary: opts.dryRun ? `Delete condition ${args.conditionId} from ${ref}.` : `Deleted condition ${args.conditionId} from ${ref}${result.published ? " and republished the shop" : ""}.`,
          data: { promoRef: ref, offerId, conditionId: args.conditionId },
          nextActions: detailAction(ref),
        };
      },
    };
  });
}

export function promoSubconditionsSetTool(ctx: McpContext, call: CallInfo, args: Args & { subconditions: z.infer<typeof AuthoringConditionSchema>[]; ref?: string; shop?: string }): Promise<CallToolResult> {
  return write(ctx, call, "promo_subconditions_set", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    return {
      tool: "promo_subconditions_set",
      shop,
      offerId,
      run: async (deps, opts) => {
        const stored = await toStoredConditions(args.subconditions, deps);
        if (!stored.ok) throw new ToolError("VALIDATION", safeText(`${stored.path ?? "subconditions"}: ${stored.error}`));
        const result = await setSubconditions(deps, { offerId, conditions: stored.value }, opts);
        if (!result.ok) throw conditionToolError(result);
        return {
          summary: opts.dryRun
            ? `Replace the sub-conditions of ${ref} with ${result.conditions.length} condition(s).`
            : `Replaced the sub-conditions of ${ref} with ${result.conditions.length} condition(s)${result.published ? " and republished the shop" : ""}.`,
          data: { promoRef: ref, offerId, conditions: result.conditions.map((c) => ({ conditionType: c.conditionType, operator: c.operator, value: c.value })) },
          nextActions: detailAction(ref),
        };
      },
    };
  });
}
