import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "@promo/db";
import { insertAuditLog } from "../../audit-log.server.js";
import {
  applyCyclePricingPlan,
  connectSkio,
  deleteOwnedCyclePricingPlan,
  deleteSkioTier,
  disconnectSkio,
  getPlan,
  listPlans,
  loadShopAdminClient,
  loadSkioStatus,
  saveSkioTier,
  syncSkio,
  type SubscriptionAdminResult,
} from "../../subscription-admin.server.js";
import { subscriptionCyclePricingPlanInputSchema, type SubscriptionCyclePricingPlan } from "../../subscription-cycle-pricing.js";
import { skioShippingTierSchema } from "../../skio-shipping-tiers.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { selectShops, visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type ApplyContext, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink } from "./catalog-shared.server.js";

const shopField = z.string().max(200).describe("Shop domain, handle or id (see shops_list).");
const writeControls = {
  dryRun: z.boolean().optional().describe("Optional, default false. true previews the change and writes nothing."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};
const planGid = z.string().trim().startsWith("gid://shopify/SellingPlanGroup/").max(200).describe("Selling plan group GID, e.g. gid://shopify/SellingPlanGroup/123 (from subscription_pricing_list).");

const planFields = subscriptionCyclePricingPlanInputSchema.shape;
export const cyclePricingPlanInput = z
  .object({
    name: planFields.name.describe("Plan name; stored as '[Freebies] <name>'."),
    intervalUnit: planFields.intervalUnit.describe("DAY | WEEK | MONTH | YEAR."),
    intervalCount: planFields.intervalCount.describe("Every N units, e.g. 1 with MONTH = monthly."),
    totalCycles: planFields.totalCycles.describe("Number of billing cycles the plan runs."),
    firstCycleDiscount: planFields.firstCycleDiscount.describe("Discount on the first shipment: { type: percentage|fixed_amount, value }."),
    recurringDiscount: planFields.recurringDiscount.describe("Discount from cycle 2 onward: { type: percentage|fixed_amount, value }."),
    productIds: z.array(z.string()).min(1).max(250).describe("Product GIDs (gid://shopify/Product/<id>) the plan attaches to; at least one, no duplicates."),
  })
  .strict();

export const subscriptionPricingListInput = { shop: shopField };
export const subscriptionPricingGetInput = { shop: shopField, planId: planGid };
export const subscriptionPricingSetInput = {
  shop: shopField,
  planId: planGid.optional().describe("Omit to CREATE a plan; give an id of a plan created by this app to UPDATE it (name, cadence, discounts, product set)."),
  plan: cyclePricingPlanInput.describe(
    'Example: { name: "Monthly 20% then $2 off", intervalUnit: "MONTH", intervalCount: 1, totalCycles: 12, firstCycleDiscount: { type: "percentage", value: 20 }, recurringDiscount: { type: "fixed_amount", value: 2 }, productIds: ["gid://shopify/Product/123"] }.',
  ),
  ...writeControls,
};
export const subscriptionPricingDeleteInput = { shop: shopField, planId: planGid, ...writeControls };
export const subscriptionOfferCreateInput = {
  shop: shopField,
  template: z.enum(["cycle-pricing", "skio-shipping"]).describe("cycle-pricing = Shopify selling plan with per-cycle discounts; skio-shipping = a Skio delivery-price tier."),
  plan: cyclePricingPlanInput.optional().describe("template cycle-pricing: the plan (same shape as subscription_pricing_set.plan)."),
  tier: skioShippingTierSchema.optional().describe(
    'template skio-shipping: a tier, e.g. { id: "free-first-box", name: "Free first box", subscriptionDurationMonths: 1, minSubtotal: 0, maxSubtotal: null, productVariantIds: null, cycleOverrides: [{ cycle: 2, override: { amount: 1.99 } }], defaultOverride: { amount: 0 } }. Creating an id that already exists is refused.',
  ),
  ...writeControls,
};
export const skioShippingStatusInput = { shop: shopField };
export const skioShippingTierSetInput = { shop: shopField, tier: skioShippingTierSchema.describe("Tier to create or replace by id (see subscription_offer_create for an example)."), ...writeControls };
export const skioShippingTierDeleteInput = { shop: shopField, tierId: z.string().trim().min(1).max(100).describe("Tier id (from skio_shipping_status)."), ...writeControls };
export const skioShippingSyncInput = { shop: shopField, ...writeControls };
export const skioShippingConnectInput = {
  shop: shopField,
  apiKey: z.string().min(1).max(4096).describe("Skio private API key. Validated against Skio, stored encrypted, write-only: no tool ever returns it."),
  ...writeControls,
};
export const skioShippingDisconnectInput = { shop: shopField, ...writeControls };

type Controls = { dryRun?: boolean; idempotencyKey?: string };
type Built = { shop: VisibleShop; preview: () => Promise<WritePreview>; apply: (apply: ApplyContext) => Promise<WriteBody> };

const handle = (shop: VisibleShop) => shopHandle(shop.myshopifyDomain);
const links = (shop: VisibleShop, path = "") => [{ label: `${handle(shop)} admin`, url: adminLink(handle(shop)).url + path }];

function unwrap<T>(result: SubscriptionAdminResult<T>): T {
  if (!result.ok) throw new ToolError("VALIDATION", result.error.replace(/\s+/g, " ").slice(0, 300));
  return result.value;
}

async function clientFor(db: Db, shop: VisibleShop) {
  const client = await loadShopAdminClient(db, shop.id);
  if (!client) throw new ToolError("UPSTREAM_UNAVAILABLE", `Shop ${shop.myshopifyDomain} has no stored Shopify access token; reinstall the app.`);
  return client;
}

async function audit(ctx: McpContext, shop: VisibleShop, a: ApplyContext, action: string, entityId: string, details: Record<string, unknown>) {
  await insertAuditLog(ctx.db, {
    shopId: shop.id,
    entityType: "subscription",
    entityId,
    action,
    after: { ...details, ...a.auditExtra },
    performedBy: a.performedBy,
  });
}

/** Resolves the shop (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
async function write(
  ctx: McpContext,
  call: CallInfo,
  tool: string,
  args: Controls & { shop: string } & Record<string, unknown>,
  build: (shop: VisibleShop) => Promise<Omit<Built, "shop">> | Omit<Built, "shop">,
  secrets: string[] = [],
): Promise<CallToolResult> {
  const started = performance.now();
  let built: Built;
  try {
    const [shop] = selectShops(await visibleShops(ctx.db, ctx.operator), [args.shop]);
    built = { shop: shop!, ...(await build(shop!)) };
  } catch (error) {
    const response = toErrorCallToolResult(error);
    const code = (response.structuredContent as { code?: string } | undefined)?.code ?? "INTERNAL";
    await logCall(ctx.db, { operatorId: ctx.operator.id, tool, shops: shopsFromArgs(args), args, outcome: code, durationMs: performance.now() - started });
    return response;
  }
  const result = await runWrite(ctx, call, {
    tool,
    args,
    dryRun: args.dryRun === true,
    idempotencyKey: args.idempotencyKey,
    shops: [built.shop],
    preview: built.preview,
    apply: built.apply,
  });
  return secrets.length ? scrubSecrets(result, secrets) : result;
}

/** runWrite echoes the call's args in the dry run's "apply" nextAction; secrets must never leave through it. */
function scrubSecrets(result: CallToolResult, keys: string[]): CallToolResult {
  const structured = result.structuredContent as { nextActions?: { args?: Record<string, unknown> }[] } | undefined;
  for (const action of structured?.nextActions ?? []) {
    for (const key of keys) if (action.args && key in action.args) action.args[key] = "<same value as this call>";
  }
  return result;
}

async function read(ctx: McpContext, shopRef: string, fn: (shop: VisibleShop) => Promise<ToolResult<unknown>>): Promise<ToolResult<unknown>> {
  const [shop] = selectShops(await visibleShops(ctx.db, ctx.operator), [shopRef]);
  return fn(shop!);
}

const planRow = (plan: SubscriptionCyclePricingPlan) => ({
  planId: plan.id,
  name: plan.name,
  intervalUnit: plan.intervalUnit,
  intervalCount: plan.intervalCount,
  totalCycles: plan.totalCycles,
  firstCycleDiscount: plan.firstCycleDiscount,
  recurringDiscount: plan.recurringDiscount,
  productIds: plan.productIds,
  productTitlesById: plan.productTitlesById,
});

export function subscriptionPricingList(ctx: McpContext, args: { shop: string }) {
  return read(ctx, args.shop, async (shop) => {
    const plans = await listPlans(await clientFor(ctx.db, shop));
    return buildResult(
      {
        summary: `${plans.length} cycle-pricing plan(s) in ${shop.myshopifyDomain}.`,
        data: { plans: plans.map(planRow) },
        links: links(shop, "/subscription-pricing"),
        nextActions: plans[0] ? [{ mcp: "promo-engine", tool: "subscription_pricing_get", args: { shop: shop.myshopifyDomain, planId: plans[0].id }, why: "Open a plan with its full product list.", risk: "read" }] : [],
      },
      ctx.now,
    );
  });
}

export function subscriptionPricingGet(ctx: McpContext, args: { shop: string; planId: string }) {
  return read(ctx, args.shop, async (shop) => {
    const plan = await getPlan(await clientFor(ctx.db, shop), args.planId);
    if (!plan) throw new ToolError("NOT_FOUND", "No cycle-pricing plan with that id was created by this app in that shop.");
    return buildResult({ summary: `Plan "${plan.name}" (${plan.productIds.length} product(s)).`, data: planRow(plan), links: links(shop, "/subscription-pricing") }, ctx.now);
  });
}

const planSummary = (plan: z.infer<typeof cyclePricingPlanInput>) =>
  `"${plan.name}" every ${plan.intervalCount} ${plan.intervalUnit.toLowerCase()}(s) for ${plan.totalCycles} cycle(s), ${plan.productIds.length} product(s)`;

export function subscriptionPricingSet(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; planId?: string; plan: z.infer<typeof cyclePricingPlanInput> }) {
  return write(ctx, call, "subscription_pricing_set", args, async (shop) => {
    const client = await clientFor(ctx.db, shop);
    const parsed = subscriptionCyclePricingPlanInputSchema.safeParse(args.plan);
    if (!parsed.success) throw new ToolError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid plan.");
    const verb = args.planId ? "Update" : "Create";
    return {
      preview: async () => {
        if (args.planId && !(await getPlan(client, args.planId))) throw new ToolError("NOT_FOUND", "That plan was not created by this app and cannot be edited here.");
        return {
          summary: `${verb} cycle-pricing plan ${planSummary(parsed.data)} in ${shop.myshopifyDomain}.`,
          data: { planId: args.planId ?? null, plan: parsed.data },
          links: links(shop, "/subscription-pricing"),
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const value = unwrap(await applyCyclePricingPlan(client, args.planId, parsed));
        await audit(ctx, shop, a, value.created ? "subscription_plan_created" : "subscription_plan_updated", value.planId ?? "unknown", { name: parsed.data.name });
        return {
          summary: `${value.created ? "Created" : "Updated"} cycle-pricing plan ${planSummary(parsed.data)}.`,
          data: { planId: value.planId, created: value.created },
          links: links(shop, "/subscription-pricing"),
          nextActions: value.planId ? [{ mcp: "promo-engine", tool: "subscription_pricing_get", args: { shop: shop.myshopifyDomain, planId: value.planId }, why: "Verify the saved plan.", risk: "read" }] : [],
        };
      },
    };
  });
}

export function subscriptionPricingDelete(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; planId: string }) {
  return write(ctx, call, "subscription_pricing_delete", args, async (shop) => {
    const client = await clientFor(ctx.db, shop);
    return {
      preview: async () => {
        const plan = await getPlan(client, args.planId);
        if (!plan) throw new ToolError("NOT_FOUND", "That plan was not created by this app and cannot be deleted here.");
        return { summary: `Delete plan "${plan.name}" (${plan.productIds.length} product(s) lose it).`, data: { planId: args.planId }, offerUpdatedAt: null };
      },
      apply: async (a) => {
        unwrap(await deleteOwnedCyclePricingPlan(client, args.planId));
        await audit(ctx, shop, a, "subscription_plan_deleted", args.planId, {});
        return { summary: `Deleted cycle-pricing plan ${args.planId}.`, data: { planId: args.planId }, links: links(shop, "/subscription-pricing") };
      },
    };
  });
}

export function subscriptionOfferCreate(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string; template: "cycle-pricing" | "skio-shipping"; plan?: z.infer<typeof cyclePricingPlanInput>; tier?: unknown },
) {
  if (args.template === "cycle-pricing") {
    if (!args.plan) return Promise.resolve(toErrorCallToolResult(new ToolError("VALIDATION", "template cycle-pricing needs `plan`.")));
    const { template: _t, tier: _tier, ...rest } = args;
    return subscriptionPricingSet(ctx, call, { ...rest, plan: args.plan });
  }
  if (!args.tier) return Promise.resolve(toErrorCallToolResult(new ToolError("VALIDATION", "template skio-shipping needs `tier`.")));
  return skioTierWrite(ctx, call, "subscription_offer_create", args, args.tier, "create");
}

export function skioShippingTierSet(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; tier: unknown }) {
  return skioTierWrite(ctx, call, "skio_shipping_tier_set", args, args.tier, "upsert");
}

function skioTierWrite(ctx: McpContext, call: CallInfo, tool: string, args: Controls & { shop: string }, rawTier: unknown, mode: "create" | "upsert") {
  return write(ctx, call, tool, args as Controls & { shop: string } & Record<string, unknown>, async (shop) => {
    const client = await clientFor(ctx.db, shop);
    const parsed = skioShippingTierSchema.safeParse(rawTier);
    if (!parsed.success) throw new ToolError("VALIDATION", parsed.error.issues.map((i) => i.message).join(" ").slice(0, 300));
    const tier = parsed.data;
    return {
      preview: async () => ({
        summary: `${mode === "create" ? "Add" : "Save"} Skio shipping tier "${tier.name}" (${tier.id}) in ${shop.myshopifyDomain}.`,
        data: { tier },
        links: links(shop, "/skio-shipping"),
        offerUpdatedAt: null,
      }),
      apply: async (a) => {
        unwrap(await saveSkioTier(client, tier, mode));
        await audit(ctx, shop, a, "skio_shipping_tier_saved", tier.id, { name: tier.name });
        return {
          summary: `Saved Skio shipping tier "${tier.name}" (${tier.id}). Run skio_shipping_sync to apply it to active subscriptions.`,
          data: { tier },
          links: links(shop, "/skio-shipping"),
          nextActions: [{ mcp: "promo-engine", tool: "skio_shipping_sync", args: { shop: shop.myshopifyDomain }, why: "Apply the delivery prices to active Skio subscriptions.", risk: "write" }],
        };
      },
    };
  });
}

export function skioShippingTierDelete(ctx: McpContext, call: CallInfo, args: Controls & { shop: string; tierId: string }) {
  return write(ctx, call, "skio_shipping_tier_delete", args, async (shop) => {
    const client = await clientFor(ctx.db, shop);
    return {
      preview: async () => ({ summary: `Delete Skio shipping tier ${args.tierId} in ${shop.myshopifyDomain}.`, data: { tierId: args.tierId }, offerUpdatedAt: null }),
      apply: async (a) => {
        unwrap(await deleteSkioTier(client, args.tierId));
        await audit(ctx, shop, a, "skio_shipping_tier_deleted", args.tierId, {});
        return { summary: `Deleted Skio shipping tier ${args.tierId}.`, data: { tierId: args.tierId }, links: links(shop, "/skio-shipping") };
      },
    };
  });
}

export function skioShippingStatus(ctx: McpContext, args: { shop: string }) {
  return read(ctx, args.shop, async (shop) => {
    const status = await loadSkioStatus(ctx.db, shop.id, await clientFor(ctx.db, shop));
    return buildResult(
      {
        summary: `Skio ${status.apiKeyConnected ? "connected" : "not connected"}; ${status.config.tiers.length} shipping tier(s)${status.configValid ? "" : "; stored config is INVALID"}.`,
        data: { apiKeyConnected: status.apiKeyConnected, configValid: status.configValid, configError: status.configError, importedFromLegacy: status.importedFromLegacy, tiers: status.config.tiers },
        warnings: status.configValid ? [] : [{ code: "SKIO_CONFIG_INVALID", severity: "block", message: "Repair the stored Skio configuration (save valid tiers) before syncing." }],
        links: links(shop, "/skio-shipping"),
      },
      ctx.now,
    );
  });
}

export function skioShippingSync(ctx: McpContext, call: CallInfo, args: Controls & { shop: string }) {
  return write(ctx, call, "skio_shipping_sync", args, async (shop) => {
    const client = await clientFor(ctx.db, shop);
    return {
      preview: async () => {
        const status = await loadSkioStatus(ctx.db, shop.id, client);
        return {
          summary: `Sync would evaluate every active Skio subscription against ${status.config.tiers.length} tier(s) and update delivery prices that differ. Skio ${status.apiKeyConnected ? "is connected" : "is NOT connected: the sync would fail"}.`,
          data: { tierCount: status.config.tiers.length, apiKeyConnected: status.apiKeyConnected, configValid: status.configValid },
          offerUpdatedAt: null,
        };
      },
      apply: async (a) => {
        const result = unwrap(await syncSkio(ctx.db, shop.id, client));
        await audit(ctx, shop, a, "skio_shipping_synced", shop.id, { evaluated: result.evaluated, updated: result.updated });
        return {
          summary: `Sync complete: ${result.updated} updated, ${result.evaluated} evaluated.`,
          data: { evaluated: result.evaluated, updated: result.updated },
          links: links(shop, "/skio-shipping"),
        };
      },
    };
  });
}

export function skioShippingConnect(
  ctx: McpContext,
  call: CallInfo,
  args: Controls & { shop: string; apiKey: string },
  validate?: Parameters<typeof connectSkio>[3],
) {
  return write(ctx, call, "skio_shipping_connect", args, (shop) => ({
    preview: async () => ({
      summary: `Validate the Skio API key against Skio and store it encrypted for ${shop.myshopifyDomain} (replaces any stored key). The key is never shown again.`,
      data: { keyLength: args.apiKey.trim().length },
      offerUpdatedAt: null,
    }),
    apply: async (a) => {
      unwrap(await connectSkio(ctx.db, shop.id, args.apiKey, validate));
      await audit(ctx, shop, a, "skio_connected", shop.id, {});
      return { summary: "Skio connected. The API key is stored encrypted and is never returned.", data: { apiKeyConnected: true }, links: links(shop, "/skio-shipping") };
    },
  }), ["apiKey"]);
}

export function skioShippingDisconnect(ctx: McpContext, call: CallInfo, args: Controls & { shop: string }) {
  return write(ctx, call, "skio_shipping_disconnect", args, (shop) => ({
    preview: async () => ({ summary: `Delete the stored Skio API key of ${shop.myshopifyDomain}; syncs stop until Skio is connected again.`, data: {}, offerUpdatedAt: null }),
    apply: async (a) => {
      await disconnectSkio(ctx.db, shop.id);
      await audit(ctx, shop, a, "skio_disconnected", shop.id, {});
      return { summary: "Skio disconnected.", data: { apiKeyConnected: false }, links: links(shop, "/skio-shipping") };
    },
  }));
}
