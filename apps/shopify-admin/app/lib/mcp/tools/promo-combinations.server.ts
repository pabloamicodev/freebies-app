import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureCapacity } from "../../capacity-capture.server.js";
import { describeCapacityModal, type CapacityModalData } from "../../capacity-modal-copy.js";
import { setCombinationPolicy, type SetCombinationFailure, type SetCombinationSuccess } from "../../offer-combination.server.js";
import { setPriority, type SetPriorityFailure } from "../../offer-priority.server.js";
import type { StoredCombinationPolicy } from "../../offer-authoring/types.js";
import { MAX_LIMIT } from "../../limit-help.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, promoRef, shopHandle, type ToolErrorPayload, type Warning } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};
const controls = {
  dryRun: z.boolean().optional().describe("Default false (applies). true previews the resulting policy/conflicts and writes nothing."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const limit = z.number().int().min(1).max(MAX_LIMIT).nullable();

export const promoSetCombinationsInput = {
  ...refFields,
  combinesWithOrderDiscounts: z.boolean().optional().describe("Shopify lets this offer's discount stack with ORDER-level discounts (e.g. other apps' order discounts, native order codes). Default for a new policy: true."),
  combinesWithProductDiscounts: z
    .boolean()
    .optional()
    .describe(
      "Shopify lets this offer's discount stack with PRODUCT-level discounts on the same lines (other apps' product discounts, native product codes). Default for a new policy: true. Shopify stores this flag once per app discount, so Promo Engine ANDs every active offer's flag shop-wide: ONE active offer with false silences the class for ALL offers (each shard/combination domain of the shop included). The result lists which other active offers restrict it.",
    ),
  combinesWithShippingDiscounts: z.boolean().optional().describe("Shopify lets this offer stack with SHIPPING discounts. Same shop-wide AND rule as product discounts. Default: true."),
  combinesWithOtherAppOffers: z.boolean().optional().describe("Allow this offer to apply alongside other active Promo Engine offers. Default: true."),
  canStackWithGiftOffers: z.boolean().optional().describe("Allow this offer to apply together with gift offers. Default: true."),
  giftValueCountsForOtherOffers: z.boolean().optional().describe("The value of gifts this offer adds counts toward other offers' cart thresholds. Default: false."),
  stopLowerPriority: z.boolean().optional().describe("When this offer qualifies, offers with a higher priority number are skipped. Also settable with promo_set_priority. Default: false."),
  maxApplicationsPerCart: limit.optional().describe(`1-${MAX_LIMIT} or null for unlimited. One application = one gift set, bundle or discounted unit depending on the reward. Ignored (and reported) for order/shipping-only offers, which apply once per order.`),
  maxApplicationsPerCustomer: limit
    .optional()
    .describe(
      `1-${MAX_LIMIT} or null for unlimited. One application = one paid order in which the offer gave a discount. Needs a unique customer-facing title on automatic offers (an error once limits are enforced for the shop, a warning before). Guests with a new email have no customer record and count as 0 uses: set requireIdentifiedCustomer to exclude them.`,
    ),
  requireIdentifiedCustomer: z.boolean().optional().describe("Only identified customers (with a Shopify customer record) get the offer. Default: false."),
  ...controls,
};

export const promoSetPriorityInput = {
  ...refFields,
  priority: z.number().int().min(-2147483647).max(2147483647).describe("Lower number = evaluated first (10 runs before 100)."),
  stopLowerPriority: z.boolean().optional().describe("true: when this offer qualifies, offers with a HIGHER priority number are not applied. Omitted keeps the stored value."),
  ...controls,
};

export const COMBINATIONS_DESCRIPTION = `Sets how one offer combines with other discounts and its usage limits; any field left out keeps its stored value (a new policy takes the defaults noted per field). The live offer is republished; a failed publish does not undo the saved policy but may pause the offer.
"Combines with product discounts" is a Shopify discount-combination class: it decides whether Shopify lets this app discount apply on the same cart as OTHER product-level discounts. Shopify keeps one combinesWith set per app discount node, so the flags of all active offers are ANDed: a single active offer with a class off disables it for every offer of the shop (the response lists the restricting offers). With function sharding / combination domains enabled the offers of a shard are evaluated together and the same AND applies per node, so a stricter offer can silence other offers that share its node.
Limits: per cart and per customer are 1-${MAX_LIMIT}; a per-customer limit on an automatic offer needs a unique public title. Example: {"ref":"promo:onesolsupps:<offerId>","combinesWithProductDiscounts":false,"maxApplicationsPerCustomer":1,"requireIdentifiedCustomer":true}.`;

export const PRIORITY_DESCRIPTION = `Sets an offer's priority and optionally "stop lower priority". Priority semantics (promo_engine): offers are evaluated in ascending priority number, so priority 10 runs before 100 and the lowest number wins ties on the same line; with stopLowerPriority true an offer that qualifies prevents every offer with a higher number from applying (that also disqualifies it from being split across Shopify discounts). Returns the shop's detected conflicts that involve this offer: same gift variant, overlapping thresholds, auto-add duplicates, stop-lower-priority warnings. The live offer is republished. Example: {"ref":"promo:onesolsupps:<offerId>","priority":5,"stopLowerPriority":true}.`;

type Controls = { dryRun?: boolean; idempotencyKey?: string };
type Policy = StoredCombinationPolicy;
const NON_POLICY = new Set(["ref", "shop", "dryRun", "idempotencyKey"]);

const safe = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);
const label = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, 80);

function capacityError(failure: { error: string }, capacity: CapacityModalData): ToolError {
  const copy = describeCapacityModal(capacity);
  const details = {
    capacity: { code: capacity.code, offerIds: capacity.offers.map((o) => o.id), numbers: capacity.numbers },
    limit: copy.limit,
    explanation: copy.body,
    workarounds: copy.fix,
    ...(capacity.incidentId ? { incidentId: capacity.incidentId } : {}),
  } as ToolErrorPayload["details"];
  return new ToolError("CAPACITY_LIMIT" as ConstructorParameters<typeof ToolError>[0], safe(`${failure.error} ${copy.limit}`), { details });
}

function failureError(failure: SetCombinationFailure | SetPriorityFailure, capacity: CapacityModalData | null, ref: string): ToolError {
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", "Offer not found in that shop.");
    case "validation":
      return new ToolError("VALIDATION", safe(failure.error));
    case "stale":
      return new ToolError("STATE_CONFLICT", safe(failure.error));
    case "publish_failed":
      if (capacity) return capacityError(failure, capacity);
      return new ToolError("PUBLISH_FAILED", `The change was saved but publishing to Shopify failed (${safe(failure.error)}). The offer may have been paused so the shop stays consistent.`, {
        suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Check the offer's current status and publish errors, then retry." },
      });
  }
}

async function prepare(
  ctx: McpContext,
  tool: string,
  args: Controls & { ref?: string; shop?: string },
): Promise<{ shop: VisibleShop; offerId: string; ref: string } | CallToolResult> {
  const started = performance.now();
  try {
    const { shop, offerId } = resolvePromoRef(await visibleShops(ctx.db, ctx.operator), args);
    return { shop, offerId, ref: promoRef(shop.myshopifyDomain, offerId) };
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
}

const isResult = (value: object): value is CallToolResult => "content" in value;

function policyWarnings(result: SetCombinationSuccess, input: Policy): Warning[] {
  const warnings: Warning[] = [];
  if (result.warning) warnings.push({ code: "LIMITED_TITLE", severity: "warn", message: safe(result.warning) });
  if (result.perCartIgnored) warnings.push({ code: "PER_CART_IGNORED", severity: "info", message: "maxApplicationsPerCart was ignored: the offer's rewards are order/shipping level and apply once per order." });
  if (typeof result.after.maxApplicationsPerCustomer === "number" && !result.after.requireIdentifiedCustomer) {
    warnings.push({
      code: "GUESTS_NOT_LIMITED",
      severity: "info",
      message: "Guests who type a new email at checkout have no customer record, count as 0 uses and still get the offer. Set requireIdentifiedCustomer to offer it only to identified customers.",
    });
  }
  if (input.combinesWithProductDiscounts === false || input.combinesWithOrderDiscounts === false || input.combinesWithShippingDiscounts === false) {
    warnings.push({
      code: "SHOP_WIDE_COMBINATION",
      severity: "info",
      message: "Shopify applies combinations per app discount: while this offer is active, a class set to false is off for every Promo Engine offer of the shop.",
    });
  }
  return warnings;
}

export async function setCombinationsTool(ctx: McpContext, call: CallInfo, args: Controls & Policy & { ref?: string; shop?: string }): Promise<CallToolResult> {
  const target = await prepare(ctx, "promo_set_combinations", args);
  if (isResult(target)) return target;
  const { shop, offerId, ref } = target;
  const input = Object.fromEntries(Object.entries(args).filter(([key, value]) => !NON_POLICY.has(key) && value !== undefined)) as Policy;
  const deps = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain };
  const links = [adminLink(shopHandle(shop.myshopifyDomain))];
  const summaryOf = (r: SetCombinationSuccess) =>
    `"${label(r.offerName)}" (${ref}) status ${r.offerStatus}: ${r.changed ? "policy changes" : "policy unchanged"}`;
  const dataOf = (r: SetCombinationSuccess) => ({ promoRef: ref, offerId, offerStatus: r.offerStatus, before: r.before, after: r.after, changed: r.changed });

  return runWrite(ctx, call, {
    tool: "promo_set_combinations",
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async (): Promise<WritePreview> => {
      const result = await setCombinationPolicy(deps, offerId, input, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
      if (!result.ok) throw failureError(result, null, ref);
      return {
        summary: `${summaryOf(result)}. A live offer is republished.`,
        data: dataOf(result),
        warnings: policyWarnings(result, input),
        links,
        offerUpdatedAt: null,
      };
    },
    apply: async (a: ApplyContext): Promise<WriteBody> => {
      const { result, capacity } = await captureCapacity(ctx.db, () =>
        setCombinationPolicy(deps, offerId, input, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }),
      );
      if (!result.ok) throw failureError(result, capacity, ref);
      return {
        summary: `Saved ${summaryOf(result)}${result.offerStatus === "active" ? "; Shopify config republished" : ""}.`,
        data: dataOf(result),
        warnings: policyWarnings(result, input),
        links,
        nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the stored policy.", risk: "read" }],
      };
    },
  });
}

export async function setPriorityTool(ctx: McpContext, call: CallInfo, args: Controls & { priority: number; stopLowerPriority?: boolean; ref?: string; shop?: string }): Promise<CallToolResult> {
  const target = await prepare(ctx, "promo_set_priority", args);
  if (isResult(target)) return target;
  const { shop, offerId, ref } = target;
  const deps = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain };
  const input = { priority: args.priority, stopLowerPriority: args.stopLowerPriority };
  const links = [adminLink(shopHandle(shop.myshopifyDomain))];
  const warningsOf = (conflicts: { severity: string; message: string; type: string }[]): Warning[] =>
    conflicts.map((c) => ({ code: `CONFLICT_${c.type.toUpperCase()}`, severity: c.severity === "error" ? "warn" : "info", message: safe(c.message) }));

  return runWrite(ctx, call, {
    tool: "promo_set_priority",
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [shop],
    preview: async (): Promise<WritePreview> => {
      const r = await setPriority(deps, offerId, input, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
      if (!r.ok) throw failureError(r, null, ref);
      return {
        summary: `Priority of "${label(r.offerName)}" (${ref}): ${r.before.priority} -> ${r.after.priority}, stopLowerPriority ${r.before.stopLowerPriority} -> ${r.after.stopLowerPriority}. ${r.conflicts.length} conflict(s) with the stored state (the change is not simulated).`,
        data: { promoRef: ref, offerId, before: r.before, after: r.after, changed: r.changed, conflicts: r.conflicts },
        warnings: warningsOf(r.conflicts),
        links,
        offerUpdatedAt: null,
      };
    },
    apply: async (a: ApplyContext): Promise<WriteBody> => {
      const { result: r, capacity } = await captureCapacity(ctx.db, () =>
        setPriority(deps, offerId, input, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }),
      );
      if (!r.ok) throw failureError(r, capacity, ref);
      return {
        summary: `Priority of ${ref} set to ${r.after.priority} (stopLowerPriority ${r.after.stopLowerPriority}). ${r.conflicts.length} conflict(s) involve this offer.`,
        data: { promoRef: ref, offerId, before: r.before, after: r.after, changed: r.changed, conflicts: r.conflicts },
        warnings: warningsOf(r.conflicts),
        links,
        nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the new priority.", risk: "read" }],
      };
    },
  });
}
