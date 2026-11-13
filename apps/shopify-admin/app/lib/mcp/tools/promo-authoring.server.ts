import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AuthoringCodesSchema,
  AuthoringConditionSchema,
  AuthoringGiftTriggerSchema,
  AuthoringOfferFields,
  AuthoringRewardSchema,
  OFFER_TYPES,
  createCodesForOffer,
  deriveMainCondition,
  familyOfRewards,
  parseOfferDates,
  resolveOfferText,
  toStoredConditions,
  toStoredRewards,
  withPublishIntent,
  type AuthoringDeps,
  type StoredCondition,
} from "../../offer-authoring/index.js";
import {
  OfferGraphRejection,
  createOfferGraph,
  updateOfferGraph,
  type AfterInsertHook,
  type OfferFields,
  type OfferGraphFailure,
  type OfferGraphSuccess,
} from "../../offer-graph.server.js";
import { parseLocalDateTimeInZone } from "../../offer-validation.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, capacityToolError, promoRef, shopHandle, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { offerConditions } from "@promo/db";
import { and, asc, eq } from "drizzle-orm";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";
import { promoDetail } from "./promo-detail.server.js";

const controls = {
  dryRun: z.boolean().optional().describe("Default false. true validates everything (including the Shopify capacity preflight for an active offer) and returns the outcome without writing or publishing anything."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result instead of creating a second offer."),
};

const combinations = z
  .strictObject({
    combinesWithOrderDiscounts: z.boolean().optional().describe("Default true."),
    combinesWithProductDiscounts: z.boolean().optional().describe("Default true."),
    combinesWithShippingDiscounts: z.boolean().optional().describe("Default true."),
    combinesWithOtherAppOffers: z.boolean().optional().describe("Default true."),
    stopLowerPriority: z.boolean().optional().describe("Default false: when true, lower-priority offers do not apply alongside this one."),
    canStackWithGiftOffers: z.boolean().optional().describe("Default true."),
    giftValueCountsForOtherOffers: z.boolean().optional().describe("Default false."),
    maxApplicationsPerCart: z.number().int().min(1).nullable().optional().describe("Cap on applications per cart; null/omitted = no cap."),
    maxApplicationsPerCustomer: z.number().int().min(1).nullable().optional().describe("Cap on paid orders per customer (enforced while the shop's limits flag is on)."),
    requireIdentifiedCustomer: z.boolean().optional().describe("Default false: when true a guest never qualifies."),
  })
  .describe("Combination policy; omitted fields take the admin wizard defaults.");

export const CREATE_EXAMPLE = `create an offer on onesolsupps: Protein & Creatine Bundle (9208279269615) 1x → 20% off, 2x → 30% off`;

export const promoCreateInput = {
  shop: z.string().max(200).describe("Shop domain or handle, e.g. onesolsupps."),
  type: z.enum(OFFER_TYPES).describe("Offer family. Its rewards must be of that family (discount: product_discount / order_discount)."),
  ...AuthoringOfferFields,
  status: z.enum(["draft", "active"]).default("draft").describe("draft saves it unpublished. active validates and publishes to Shopify now (scheduled instead when startsAt is in the future); a failed publish leaves it as a draft and reports why."),
  conditions: z.array(AuthoringConditionSchema).max(50).optional().describe("Extra eligibility conditions. The main condition is derived from the rewards (e.g. cart_quantity gte the lowest tier) unless you give a scope 'main' one. Upsell offers derive their own main/visibility conditions; yours become sub-conditions."),
  rewards: z.array(AuthoringRewardSchema).min(1).max(20).describe("What the customer gets, discriminated by `kind`: product_discount / order_discount (discount), product_gift (gift), bundle_discount (bundle), upsell_discount (upsell), shipping_discount (shipping). Money in shop-currency major units, ids numeric or GID."),
  trigger: AuthoringGiftTriggerSchema.optional().describe("Gift offers only: what triggers the gift (cart_value, cart_quantity or specific_product). Omit it for tiered gifts (or gifts with minCartSubtotal): the lowest tier is used."),
  codes: AuthoringCodesSchema.optional().describe("Make it a code offer: { code: 'SUMMER10' } or { batch: { count: 100, prefix: 'VIP-' } } (customers enter the code at checkout), plus optional discountMessage, usageLimit, oncePerCustomer, codeStartsAt/codeEndsAt. { redemption: 'automatic' } keeps it a no-code offer. The offer and its codes are created together: an invalid or taken code creates nothing."),
  combinations: combinations.optional(),
  ...controls,
};

export const promoUpdateInput = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
  internalName: AuthoringOfferFields.internalName.optional().describe("New internal name; must be unique in the shop."),
  publicTitle: AuthoringOfferFields.publicTitle,
  cartLabels: AuthoringOfferFields.cartLabels,
  description: AuthoringOfferFields.description,
  priority: AuthoringOfferFields.priority,
  startsAt: AuthoringOfferFields.startsAt,
  endsAt: AuthoringOfferFields.endsAt,
  tierMode: AuthoringOfferFields.tierMode,
  conditions: z.array(AuthoringConditionSchema).max(50).optional().describe("REPLACES every condition of the offer (include the main condition). Omit to keep them."),
  rewards: z.array(AuthoringRewardSchema).min(1).max(20).optional().describe("REPLACES every reward of the offer. When `conditions` is omitted, the main condition is re-derived from the new rewards if it still has the derived shape (e.g. cart_quantity gte the lowest tier); a hand-made main condition is kept and a warning says so. Bundle offers cannot have rewards replaced. Omit to keep them."),
  expectedUpdatedAt: z.string().max(40).optional().describe("The `updatedAt` you last read (from promo_detail or a previous result). The call fails with STATE_CONFLICT when the offer changed since."),
  ...controls,
};

type CreateArgs = { [K in keyof typeof promoCreateInput]: z.input<(typeof promoCreateInput)[K]> };
type UpdateArgs = { [K in keyof typeof promoUpdateInput]: z.input<(typeof promoUpdateInput)[K]> };

/** Maps a service failure to the MCP error; a Shopify limit becomes CAPACITY_LIMIT with the limit, numbers and workarounds. */
export function graphToolError(failure: OfferGraphFailure, offerRef?: string): ToolError {
  const saved = failure.offerId ? ` The offer was saved (${offerRef ?? failure.offerId}, status ${failure.status ?? "draft"}).` : "";
  const message = `${failure.error.replace(/\s+/g, " ").slice(0, 600)}${failure.path ? ` (at ${failure.path})` : ""}${saved}`;
  if (failure.capacity) {
    const { code, offerIds, numbers, incidentId, workarounds } = failure.capacity;
    return capacityToolError({ code, offerIds, numbers }, message, {
      ...(incidentId ? { incidentId } : {}),
      ...(failure.offerId ? { offerId: failure.offerId } : {}),
      ...(workarounds ? { workarounds } : {}),
      ...(failure.offerId && offerRef ? { suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref: offerRef }, why: "Review the saved draft, then apply a workaround and activate it again." } } : {}),
    });
  }
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", "Offer not found in that shop.");
    case "state":
      return new ToolError(failure.reason === "stale" ? "STATE_CONFLICT" : "INVALID_STATE", message);
    case "validation":
      return new ToolError("VALIDATION", message);
    case "publish_failed":
      return new ToolError("PUBLISH_FAILED", message, {
        suggestedAction: offerRef
          ? { mcp: "promo-engine", tool: "promo_detail", args: { ref: offerRef }, why: "Check the offer's current status and publish errors, then retry." }
          : { mcp: "promo-engine", tool: "promo_health", args: {}, why: "Check publish errors, then retry." },
      });
  }
}

/** Resolves the shop (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function guarded(
  ctx: McpContext,
  tool: string,
  args: Record<string, unknown>,
  build: (visible: VisibleShop[]) => Promise<{ shop: VisibleShop; visible: VisibleShop[]; preview: () => Promise<WritePreview>; apply: (a: ApplyContext) => Promise<WriteBody> }>,
  call: CallInfo,
): Promise<CallToolResult> {
  const started = performance.now();
  let built: Awaited<ReturnType<typeof build>>;
  try {
    built = await build(await visibleShops(ctx.db, ctx.operator));
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  return runWrite(ctx, call, {
    tool,
    args,
    dryRun: args["dryRun"] === true,
    idempotencyKey: args["idempotencyKey"] as string | undefined,
    shops: [built.shop],
    preview: built.preview,
    apply: built.apply,
  });
}

const depsOf = (db: McpContext["db"], shop: VisibleShop): AuthoringDeps => ({ db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode, timezone: shop.timezone });

/** undefined keeps the stored date, null/empty clears it; the pair is validated by the service against the stored one. */
function oneDate(raw: string | null | undefined, path: "startsAt" | "endsAt", timezone: string): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const date = parseLocalDateTimeInZone(raw, timezone);
  if (!date || Number.isNaN(date.getTime())) throw toolError(`${path === "startsAt" ? "Start" : "End"} date is invalid.`, path);
  return date;
}

function toolError(error: string, path?: string): ToolError {
  return new ToolError("VALIDATION", `${error}${path ? ` (at ${path})` : ""}`);
}

const KINDS_BY_TYPE: Record<string, readonly string[] | undefined> = {
  discount: ["product_discount", "order_discount"],
  gift: ["product_gift"],
  bundle: ["bundle_discount"],
  upsell: ["upsell_discount"],
  shipping: ["shipping_discount"],
};

export function promoCreateTool(ctx: McpContext, call: CallInfo, args: CreateArgs): Promise<CallToolResult> {
  return guarded(ctx, "promo_create", args, async (visible) => {
    const [shop] = selectShops(visible, [args.shop]);
    const deps = depsOf(ctx.db, shop!);
    const parsed = z.strictObject(promoCreateInput).safeParse(args);
    if (!parsed.success) throw toolError(parsed.error.issues[0]?.message ?? "Invalid input.", parsed.error.issues[0]?.path.join("."));
    const input = parsed.data;
    const allowed = KINDS_BY_TYPE[input.type];
    const wrong = allowed ? input.rewards.find((reward) => !allowed.includes((reward as { kind: string }).kind)) : undefined;
    if (wrong) throw toolError(`A ${input.type} offer takes ${allowed!.join(" / ")} rewards, not "${(wrong as { kind: string }).kind}".`, "rewards");

    if (input.trigger && input.type !== "gift") throw toolError("`trigger` is only for gift offers.", "trigger");

    const text = resolveOfferText(input);
    if (!text.ok) throw toolError(text.error, text.path);
    const dates = parseOfferDates(input, deps.timezone);
    if (!dates.ok) throw toolError(dates.error, dates.path);
    // Bundles and upsells run the wizard's publish-time checks (products picked, positive discount) only for an offer going live.
    const rewardInputs = withPublishIntent(input.rewards as Array<{ kind: string }>, input.status);
    const rewards = await toStoredRewards(rewardInputs, deps);
    if (!rewards.ok) throw toolError(rewards.error, rewards.path);
    const given = input.conditions ? await toStoredConditions(input.conditions, deps) : { ok: true as const, value: [] as StoredCondition[] };
    if (!given.ok) throw toolError(given.error, given.path);
    const family = familyOfRewards(rewardInputs);
    let conditions = [...given.value];
    if (input.trigger && conditions.some((condition) => condition.scope === "main")) throw toolError("Pass either `trigger` or a scope 'main' condition, not both.", "trigger");
    if (family?.extraConditions) {
      const built = family.extraConditions(rewardInputs, deps, conditions);
      if (!built.ok) throw toolError(built.error, built.path);
      conditions = built.value;
    } else if (!conditions.some((condition) => condition.scope === "main")) {
      const derived = deriveMainCondition(rewardInputs, deps, { status: input.status, trigger: input.trigger });
      if (derived && !derived.ok) throw toolError(derived.error, derived.path);
      if (derived) conditions.unshift(derived.value);
    }
    const withCodes = input.codes !== undefined && input.codes.redemption !== "automatic";
    const tierMode = input.tierMode ?? (input.type === "gift" && input.rewards.some((reward) => (reward as { tiers?: unknown }).tiers) ? "cumulative" : undefined);
    const codeWarnings: Warning[] = [];
    const afterInsert: AfterInsertHook[] = [];
    if (family?.afterInsert) afterInsert.push(family.afterInsert(rewardInputs, deps));
    if (input.codes) {
      const codes = input.codes;
      afterInsert.push(async (tx, offerId) => {
        const made = await createCodesForOffer(tx as unknown as AuthoringDeps["db"], deps, offerId, codes);
        if (!made.ok) throw new OfferGraphRejection(`${made.error}${made.path ? ` (at codes.${made.path})` : ""}`);
        if (made.value.warning) codeWarnings.push({ code: "CODE_WARNING", severity: "warn", message: made.value.warning });
      });
    }
    const offer: OfferFields = {
      type: input.type,
      internalName: input.internalName,
      publicTitle: text.value.publicTitle,
      cartLabels: text.value.cartLabels,
      description: input.description,
      priority: input.priority,
      startsAt: dates.value.startsAt,
      endsAt: dates.value.endsAt,
      tierMode,
      requiresCode: withCodes,
    };
    const graph = {
      offer,
      status: input.status,
      conditions,
      rewards: rewards.value,
      policy: { ...(family?.combinationPolicy?.(rewardInputs) ?? {}), ...definedOnly(input.combinations ?? {}) },
      afterInsert,
    };

    return {
      shop: shop!,
      visible,
      preview: async () => {
        const result = await createOfferGraph(deps, graph, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
        if (!result.ok) throw graphToolError(result);
        return {
          summary: `Create ${input.type} offer "${result.internalName}" in ${shop!.myshopifyDomain} as ${result.status}${result.status === "active" ? "; it passed the validation and Shopify capacity preflight and would go live now" : ""}.`,
          data: { status: result.status, internalName: result.internalName, conditions: conditions.map(({ conditionType, scope, operator, value }) => ({ conditionType, scope, operator, value })), rewards: rewards.value.map(({ rewardType, discountType, value, target }) => ({ rewardType, discountType, value, target })) },
          links: [adminLink(shopHandle(shop!.myshopifyDomain))],
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const result = await createOfferGraph(deps, graph, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish });
        if (!result.ok) throw graphToolError(result, result.offerId ? promoRef(shop!.myshopifyDomain, result.offerId) : undefined);
        return created(ctx, visible, shop!, result, input.status, codeWarnings);
      },
    };
  }, call);
}

const definedOnly = <T extends Record<string, unknown>>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

async function created(ctx: McpContext, visible: VisibleShop[], shop: VisibleShop, result: OfferGraphSuccess, requested: "draft" | "active", extra: Warning[] = []): Promise<WriteBody> {
  const ref = promoRef(shop.myshopifyDomain, result.offerId!);
  const warnings: Warning[] = [...extra];
  if (requested === "active" && result.status === "scheduled") warnings.push({ code: "SCHEDULED", severity: "info", message: "startsAt is in the future: the offer is scheduled and goes live automatically at that time." });
  const detail = await promoDetail(ctx.db, visible, { ref }, ctx.now);
  return {
    summary: `Created ${result.status} offer "${result.internalName}" (${ref}) in ${shop.myshopifyDomain}${result.status === "active" ? " and published it to Shopify" : ""}.`,
    data: { promoRef: ref, offerId: result.offerId, status: result.status, internalName: result.internalName, updatedAt: result.updatedAt?.toISOString() ?? null, offer: detail.data },
    warnings: [...warnings, ...detail.warnings],
    links: [adminLink(shopHandle(shop.myshopifyDomain), `${shop.myshopifyDomain} admin (offer ${result.offerId})`)],
    nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Review the offer as stored.", risk: "read" }],
  };
}

const sameKeys = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const left = Object.keys(a).sort().join(",");
  return left === Object.keys(b).sort().join(",");
};

/**
 * Replacing rewards changes the tier minimums the main condition was derived from. When the stored main condition has exactly
 * the derived shape (same type, operator and fields) it is re-derived from the new rewards; otherwise (a hand-made main
 * condition) it is kept and the caller is warned. Returns the full condition list to store, or none when nothing changes.
 */
async function rederiveMainCondition(
  db: AuthoringDeps["db"],
  deps: AuthoringDeps,
  offerId: string,
  rewardInputs: Array<{ kind: string }>,
): Promise<{ conditions?: StoredCondition[]; warning?: Warning }> {
  const rows = await db
    .select()
    .from(offerConditions)
    .where(and(eq(offerConditions.shopId, deps.shopId), eq(offerConditions.offerId, offerId)))
    .orderBy(asc(offerConditions.sortOrder));
  const stored: StoredCondition[] = rows.map((row) => ({ scope: row.scope, conditionType: row.conditionType as StoredCondition["conditionType"], operator: row.operator, value: row.value as Record<string, unknown>, sortOrder: row.sortOrder, isEnabled: row.isEnabled }));
  const mainIndex = stored.findIndex((condition) => condition.scope === "main");
  const kept = (why: string): { warning: Warning } => ({ warning: { code: "MAIN_CONDITION_KEPT", severity: "warn", message: `Rewards replaced; the main condition was kept as stored (${why}). Send \`conditions\` too if its threshold must follow the new tiers.` } });
  if (familyOfRewards(rewardInputs)?.extraConditions) return kept("this offer type derives its conditions at creation");
  const derived = deriveMainCondition(rewardInputs, deps, { status: "draft" });
  if (!derived || !derived.ok) return mainIndex >= 0 ? kept("it cannot be derived from these rewards") : {};
  const next = derived.value;
  if (mainIndex < 0) return { conditions: [next, ...stored] };
  const current = stored[mainIndex]!;
  if (JSON.stringify([current.conditionType, current.operator, current.value]) === JSON.stringify([next.conditionType, next.operator, next.value])) return {};
  const wasDerived = current.conditionType === next.conditionType && current.operator === next.operator && sameKeys(current.value, next.value);
  if (!wasDerived) return kept("it is not the derived one");
  return { conditions: stored.map((condition, index) => (index === mainIndex ? { ...condition, value: next.value } : condition)) };
}

export function promoUpdateTool(ctx: McpContext, call: CallInfo, args: UpdateArgs): Promise<CallToolResult> {
  return guarded(ctx, "promo_update", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, { ref: args.ref, shop: args.shop });
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const deps = depsOf(ctx.db, shop);
    const parsed = z.strictObject(promoUpdateInput).safeParse(args);
    if (!parsed.success) throw toolError(parsed.error.issues[0]?.message ?? "Invalid input.", parsed.error.issues[0]?.path.join("."));
    const input = parsed.data;

    const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt) : undefined;
    if (expected && Number.isNaN(expected.getTime())) throw toolError("expectedUpdatedAt must be an ISO timestamp.", "expectedUpdatedAt");
    const startsAt = oneDate(input.startsAt, "startsAt", deps.timezone);
    const endsAt = oneDate(input.endsAt, "endsAt", deps.timezone);
    const text = input.publicTitle !== undefined || input.cartLabels !== undefined ? resolveOfferText({ internalName: input.internalName ?? "x", publicTitle: input.publicTitle, cartLabels: input.cartLabels }) : null;
    if (text && !text.ok) throw toolError(text.error, text.path);
    const rewards = input.rewards ? await toStoredRewards(input.rewards as Array<{ kind: string }>, deps) : null;
    if (rewards && !rewards.ok) throw toolError(rewards.error, rewards.path);
    let conditions = input.conditions ? await toStoredConditions(input.conditions, deps) : null;
    if (conditions && !conditions.ok) throw toolError(conditions.error, conditions.path);
    const warnings: Warning[] = [];
    if (input.rewards) {
      const rewardInputs = input.rewards as Array<{ kind: string }>;
      if (familyOfRewards(rewardInputs)?.afterInsert) throw toolError("Bundle offers keep their steps and tiers in separate tables: recreate the bundle with promo_create instead of replacing its rewards.", "rewards");
      if (!conditions) {
        const rederived = await rederiveMainCondition(ctx.db, deps, offerId, rewardInputs);
        if (rederived.conditions) conditions = { ok: true, value: rederived.conditions };
        if (rederived.warning) warnings.push(rederived.warning);
      }
    }

    const patch = {
      offer: {
        ...(input.internalName !== undefined ? { internalName: input.internalName } : {}),
        ...(text?.ok && input.publicTitle !== undefined ? { publicTitle: text.value.publicTitle } : {}),
        ...(text?.ok && input.cartLabels !== undefined ? { cartLabels: text.value.cartLabels } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.tierMode !== undefined ? { tierMode: input.tierMode } : {}),
        ...(startsAt !== undefined ? { startsAt } : {}),
        ...(endsAt !== undefined ? { endsAt } : {}),
      },
      ...(conditions?.ok ? { conditions: conditions.value } : {}),
      ...(rewards?.ok ? { rewards: rewards.value } : {}),
    };

    return {
      shop,
      visible,
      preview: async () => {
        const result = await updateOfferGraph(deps, offerId, patch, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true, expectedUpdatedAt: expected });
        if (!result.ok) throw graphToolError(result, ref);
        return {
          summary: `Update ${ref} (${result.statusBefore} -> ${result.status}): ${Object.keys(patch.offer).join(", ") || "no offer fields"}${rewards ? `, ${rewards.ok ? rewards.value.length : 0} reward(s) replaced` : ""}${conditions ? `, conditions replaced` : ""}.`,
          data: { promoRef: ref, offerId, statusBefore: result.statusBefore, statusAfter: result.status, fields: Object.keys(patch.offer), rewardsReplaced: Boolean(rewards), conditionsReplaced: Boolean(conditions) },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          warnings,
          offerUpdatedAt: result.updatedAt,
        };
      },
      apply: async (a) => {
        const result = await updateOfferGraph(deps, offerId, patch, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: expected ?? a.expectedUpdatedAt ?? undefined });
        if (!result.ok) throw graphToolError(result, ref);
        const detail = await promoDetail(ctx.db, visible, { ref }, ctx.now);
        return {
          summary: `Updated ${ref}: ${result.statusBefore} -> ${result.status}${result.status === "active" ? "; the shop config was republished" : ""}.`,
          data: { promoRef: ref, offerId, statusBefore: result.statusBefore, status: result.status, updatedAt: result.updatedAt?.toISOString() ?? null, offer: detail.data },
          warnings: [...warnings, ...detail.warnings],
          links: [adminLink(shopHandle(shop.myshopifyDomain), `${shop.myshopifyDomain} admin (offer ${offerId})`)],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Review the offer as stored.", risk: "read" }],
        };
      },
    };
  }, call);
}
