import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DiscountTypeSchema, RewardTypeSchema, TrackModeSchema } from "@promo/shared-types";
import { toStoredAmount } from "../../money.js";
import { AuthoringRewardSchema, toStoredRewards } from "../../offer-authoring/index.js";
import type { AuthoringDeps, StoredReward } from "../../offer-authoring/types.js";
import { addReward, deleteReward, updateReward, type OfferRewardFailure, type OfferRewardResult, type RewardWrite } from "../../offer-rewards.server.js";
import type { RewardRecordData } from "../../reward-record.server.js";
import { logCall, shopsFromArgs } from "../call-log.server.js";
import { ToolError, promoRef, shopHandle } from "../result.server.js";
import { toErrorCallToolResult, type McpContext } from "../server.server.js";
import { visibleShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type CallInfo, type WriteBody, type WritePreview } from "../write-runner.server.js";
import { adminLink, resolvePromoRef } from "./catalog-shared.server.js";
import { offerBasics } from "./write-tools.server.js";

type Controls = { dryRun?: boolean; idempotencyKey?: string };

const refFields = {
  ref: z.string().max(200).optional().describe("promo:<shopHandle>:<offerId>, or a bare offerId together with `shop`."),
  shop: z.string().max(200).optional().describe("Shop domain or handle; only needed when ref is a bare offerId."),
};
const controls = {
  dryRun: z.boolean().optional().describe("Optional preview (default false): validates and shows what would be written, writes and publishes nothing."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

const storedRewardSchema = z.strictObject({
  rewardType: RewardTypeSchema.describe("product_gift | order_discount | shipping_discount | product_discount (and bundle/upsell kinds)."),
  discountType: DiscountTypeSchema.describe("percentage | fixed_amount | fixed_price | free | cheapest_item_free | most_expensive_item_discount."),
  value: z.record(z.string(), z.unknown()).describe("Stored value, e.g. { amount: 20, currencyCode: 'USD' } or { amount: 0, currencyCode: 'USD', tiers: [...] }. Percentages are 0-100; money is in minor units."),
  target: z.record(z.string(), z.unknown()).describe("Stored target, e.g. { productIds: ['gid://shopify/Product/1'], scopeMode: 'sitewide' } or { scope: 'cart' }."),
  quantity: z.number().int().min(1).max(250).nullable().optional(),
  isAutoAdd: z.boolean().optional(),
  isCustomerSelectable: z.boolean().optional(),
  trackMode: TrackModeSchema.optional(),
  label: z.string().max(120).nullable().optional(),
  minCartSubtotal: z.number().positive().nullable().optional().describe("Gift tiers: cart subtotal in major units that unlocks this gift (null clears it, omitted keeps it)."),
});
type StoredRewardArgs = z.infer<typeof storedRewardSchema>;

export const promoRewardUpsertInput = {
  ...refFields,
  rewardId: z.string().uuid().optional().describe("Reward to update (from promo_detail). Omit to add a new reward to the offer."),
  reward: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Authoring reward (same shape as promo_create rewards, discriminated by `kind`, money in major units). Give this OR `stored`."),
  stored: storedRewardSchema
    .optional()
    .describe("Reward exactly as stored; checked with the same schema the Function compiler uses. Give this OR `reward`."),
  ...controls,
};
export const promoRewardDeleteInput = {
  ...refFields,
  rewardId: z.string().uuid().describe("Reward to delete (from promo_detail). The last reward of an active offer cannot be deleted."),
  ...controls,
};

type UpsertArgs = Controls & { ref?: string; shop?: string; rewardId?: string; reward?: Record<string, unknown>; stored?: StoredRewardArgs };
type DeleteArgs = Controls & { ref?: string; shop?: string; rewardId: string };

type Built = {
  tool: string;
  shops: VisibleShop[];
  preview: () => Promise<WritePreview>;
  apply: (apply: Parameters<Parameters<typeof runWrite>[2]["apply"]>[0]) => Promise<WriteBody>;
};

/** Resolves refs (a failure is logged and returned as a tool error), then hands the spec to runWrite. */
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

const safe = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

function rewardToolError(failure: OfferRewardFailure, ref: string): ToolError {
  switch (failure.code) {
    case "not_found":
      return new ToolError("NOT_FOUND", safe(failure.error));
    case "validation":
      return new ToolError("VALIDATION", safe(failure.error));
    case "state":
      return new ToolError("STATE_CONFLICT", safe(failure.error));
    case "publish_failed":
      return new ToolError("PUBLISH_FAILED", `The reward change was saved but publishing to Shopify failed (${safe(failure.error)}). The offer may need a republish.`, {
        suggestedAction: { mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Check the offer's current status and publish errors, then retry." },
      });
  }
}

function expectOk<T>(result: OfferRewardResult<T>, ref: string): T {
  if (!result.ok) throw rewardToolError(result, ref);
  return result.value;
}

const toRecord = (stored: StoredReward): RewardRecordData => ({
  rewardType: stored.rewardType,
  discountType: stored.discountType,
  value: stored.value,
  target: stored.target,
  quantity: stored.quantity ?? null,
  isAutoAdd: stored.isAutoAdd ?? false,
  isCustomerSelectable: stored.isCustomerSelectable ?? false,
  trackMode: stored.trackMode ?? "product",
  label: stored.label ?? null,
  ...(stored.minCartSubtotalCents !== undefined ? { minCartSubtotalCents: stored.minCartSubtotalCents } : {}),
});

async function rewardsFromArgs(args: UpsertArgs, deps: AuthoringDeps): Promise<RewardWrite[]> {
  if ((args.reward ? 1 : 0) + (args.stored ? 1 : 0) !== 1) {
    throw new ToolError("VALIDATION", "Pass exactly one of `reward` (authoring shape) or `stored` (stored row).");
  }
  if (args.stored) {
    const s = args.stored;
    return [
      {
        record: {
          rewardType: s.rewardType,
          discountType: s.discountType,
          value: s.value,
          target: s.target,
          quantity: s.quantity ?? null,
          isAutoAdd: s.isAutoAdd ?? false,
          isCustomerSelectable: s.isCustomerSelectable ?? false,
          trackMode: s.trackMode ?? "product",
          label: s.label?.trim() ? s.label.trim() : null,
          ...(s.minCartSubtotal !== undefined ? { minCartSubtotalCents: s.minCartSubtotal === null ? null : toStoredAmount(s.minCartSubtotal, deps.shopCurrency) } : {}),
        },
      },
    ];
  }
  const parsed = AuthoringRewardSchema.safeParse(args.reward);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ToolError("VALIDATION", safe(`reward${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid reward"}`));
  }
  const stored = await toStoredRewards([parsed.data], deps);
  if (!stored.ok) throw new ToolError("VALIDATION", safe(stored.path ? `${stored.path}: ${stored.error}` : stored.error));
  if (stored.value.length === 0) throw new ToolError("VALIDATION", "The reward produced nothing to store.");
  return stored.value.map((row) => ({ record: toRecord(row) }));
}

export function rewardUpsertTool(ctx: McpContext, call: CallInfo, args: UpsertArgs): Promise<CallToolResult> {
  return guardedWrite(ctx, call, "promo_reward_upsert", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const deps: AuthoringDeps = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode, timezone: shop.timezone };
    const rewards = await rewardsFromArgs(args, deps);
    if (args.rewardId && rewards.length !== 1) {
      throw new ToolError("VALIDATION", "This reward expands to several stored rewards, so it cannot replace one existing reward; omit rewardId to add them.");
    }
    const action = args.rewardId ? "update" : "add";
    type Values = Array<{ rewardId: string | null; rewardType: string; discountType: string }>;
    const run = async (opts: Parameters<typeof addReward>[3]): Promise<Values> => {
      const values: Values = [];
      for (const reward of rewards) {
        const result = args.rewardId ? await updateReward(deps, offerId, args.rewardId, reward, opts) : await addReward(deps, offerId, reward, opts);
        values.push(expectOk(result, ref));
      }
      return values;
    };
    const data = (values: Values) => ({
      promoRef: ref,
      offerId,
      action,
      rewards: values.map((v) => ({ rewardId: v.rewardId, rewardType: v.rewardType, discountType: v.discountType })),
    });
    return {
      tool: "promo_reward_upsert",
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const values = await run({ performedBy: `mcp:${ctx.operator.id}`, dryRun: true });
        return {
          summary: `${action === "add" ? "Add" : "Update"} ${values.length} reward(s) (${values.map((v) => v.rewardType).join(", ")}) ${action === "add" ? "to" : "of"} offer ${ref}.${basics.status === "active" ? " The offer is live: the shop config is republished." : ""}`,
          data: data(values),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const values = await run({ performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined });
        return {
          summary: `${action === "add" ? "Added" : "Updated"} ${values.length} reward(s) on ${ref}.`,
          data: data(values),
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the offer's rewards.", risk: "read" }],
        };
      },
    };
  });
}

export function rewardDeleteTool(ctx: McpContext, call: CallInfo, args: DeleteArgs): Promise<CallToolResult> {
  return guardedWrite(ctx, call, "promo_reward_delete", args, async (visible) => {
    const { shop, offerId } = resolvePromoRef(visible, args);
    const ref = promoRef(shop.myshopifyDomain, offerId);
    const deps: AuthoringDeps = { db: ctx.db, shopId: shop.id, shopDomain: shop.myshopifyDomain, shopCurrency: shop.currencyCode, timezone: shop.timezone };
    return {
      tool: "promo_reward_delete",
      shops: [shop],
      preview: async () => {
        const basics = await offerBasics(ctx.db, shop, offerId);
        const value = expectOk(await deleteReward(deps, offerId, args.rewardId, { performedBy: `mcp:${ctx.operator.id}`, dryRun: true }), ref);
        return {
          summary: `Delete reward ${args.rewardId} from offer ${ref}; ${value.remaining} reward(s) remain.`,
          data: { promoRef: ref, offerId, rewardId: value.rewardId, remaining: value.remaining },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          offerUpdatedAt: basics.updatedAt,
        };
      },
      apply: async (a) => {
        const value = expectOk(
          await deleteReward(deps, offerId, args.rewardId, { performedBy: a.performedBy, auditExtra: a.auditExtra, publish: a.publish, expectedUpdatedAt: a.expectedUpdatedAt ?? undefined }),
          ref,
        );
        return {
          summary: `Deleted reward ${args.rewardId} from ${ref}; ${value.remaining} reward(s) remain.`,
          data: { promoRef: ref, offerId, rewardId: value.rewardId, remaining: value.remaining },
          links: [adminLink(shopHandle(shop.myshopifyDomain))],
          nextActions: [{ mcp: "promo-engine", tool: "promo_detail", args: { ref }, why: "Verify the offer's rewards.", risk: "read" }],
        };
      },
    };
  });
}
